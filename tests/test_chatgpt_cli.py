import importlib.machinery
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


CLI_PATH = Path(__file__).resolve().parents[1] / "bin" / "chatgpt"
LOADER = importlib.machinery.SourceFileLoader("chatgpt_cli", str(CLI_PATH))
SPEC = importlib.util.spec_from_loader("chatgpt_cli", LOADER)
assert SPEC and SPEC.loader
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class ChatGptCliTests(unittest.TestCase):
    def test_conversation_reference_requires_exact_id_or_url(self):
        identifier = "12345678-1234-1234-1234-1234567890ab"
        self.assertEqual(
            cli._conversation_ref(identifier),
            (identifier, f"https://chatgpt.com/c/{identifier}"),
        )
        self.assertEqual(
            cli._conversation_ref(f"https://chatgpt.com/c/{identifier}/"),
            (identifier, f"https://chatgpt.com/c/{identifier}"),
        )
        self.assertIsNone(cli._conversation_ref("A useful conversation title"))
        self.assertIsNone(cli._conversation_ref(f"https://chatgpt.com/c/{identifier}?view=full"))

    def test_project_reference_requires_exact_id_or_url(self):
        self.assertEqual(cli._project_ref("g-p-abc123"), "g-p-abc123")
        self.assertEqual(
            cli._project_ref("https://chatgpt.com/g/g-p-abc123-project"),
            "g-p-abc123",
        )
        self.assertIsNone(cli._project_ref("Personal project"))

    def test_config_reader_gets_auth_and_port_without_yaml_dependency(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "config.yaml"
            path.write_text(
                "server:\n  port: 17841\n  auth: \"test-token\" # local token\n\nbackend:\n  port: 9\n",
                encoding="utf-8",
            )
            self.assertEqual(cli._read_server_config(path), ("test-token", 17841))

    def test_json_flag_is_accepted_before_or_after_command(self):
        before = cli._parse_args(["--json", "read", "12345678-1234-1234-1234-1234567890ab"])
        after = cli._parse_args(["read", "12345678-1234-1234-1234-1234567890ab", "--json"])
        self.assertTrue(before.json_output)
        self.assertTrue(after.json_output)

    def test_project_create_command_is_available_after_route_landed(self):
        args = cli._parse_args(["projects", "create", "A test project"])
        self.assertEqual(args.projects_command, "create")
        self.assertEqual(args.name, ["A test project"])

    def test_search_uses_server_side_search_endpoint(self):
        seen = {}

        class FakeClient:
            def request(self, method, path, *, query=None, body=None):
                seen["method"] = method
                seen["path"] = path
                seen["query"] = query
                return {"items": [{"id": "12345678-1234-1234-1234-1234567890ab", "title": "Match"}] * 3}

        args = cli._parse_args(["conversations", "search", "needle", "--limit", "2"])
        data = cli._cmd_conversations_search(FakeClient(), args)
        self.assertEqual(seen["path"], "/admin/chatgpt/search")
        self.assertEqual(seen["query"], {"q": "needle"})
        self.assertEqual(len(data["items"]), 3)

    def test_status_line_is_omitted_when_items_carry_no_stream_status(self):
        lines = cli._conversation_lines(
            [{"id": "12345678-1234-1234-1234-1234567890ab", "title": "T"}], empty=""
        )
        self.assertFalse(any("Status:" in line for line in lines))
        listed = cli._conversation_lines(
            [
                {
                    "id": "12345678-1234-1234-1234-1234567890ab",
                    "title": "T",
                    "stream_status": None,
                }
            ],
            empty="",
        )
        self.assertTrue(any("Status: UNKNOWN" in line for line in listed))

    def test_stream_request_accumulates_sse_and_extracts_conversation_url(self):
        import io

        events = [
            b'data: {"id":"c1","model":"gpt-instant","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n',
            b":keepalive\n\n",
            b'data: {"id":"c1","model":"gpt-instant","conversation_url":"https://chatgpt.com/c/abc","choices":[{"index":0,"delta":{"content":"full text"},"finish_reason":"stop"}]}\n\n',
            b"data: [DONE]\n\n",
        ]

        class FakeResponse:
            def __enter__(self):
                return io.BytesIO(b"".join(events))

            def __exit__(self, *exc_info):
                return False

        original_urlopen = cli.urlopen
        cli.urlopen = lambda request, timeout: FakeResponse()
        try:
            data = cli.ApiClient.__new__(cli.ApiClient)
            data.base_url = "http://127.0.0.1:1"
            data.auth = "unused"
            data.timeout = 5
            result = data.request_stream(
                "POST",
                "/v1/chat/completions",
                body={"model": "gpt-instant", "messages": [], "stream": True},
            )
        finally:
            cli.urlopen = original_urlopen

        self.assertEqual(result["choices"][0]["message"]["content"], "full text")
        self.assertEqual(result["conversation_url"], "https://chatgpt.com/c/abc")
        self.assertEqual(result["model"], "gpt-instant")

    def test_dispatch_command_passes_spawner_task_and_model(self):
        args = cli._parse_args(
            ["dispatch", "--spawner", "aiva", "--task", "registry smoke test", "--model", "gpt-thinking", "Reply", "DONE"]
        )
        self.assertEqual(args.spawner, "aiva")
        self.assertEqual(args.task, ["registry smoke test"])
        self.assertEqual(args.model, "gpt-thinking")
        self.assertEqual(args.message, ["Reply", "DONE"])

    def test_dispatch_submits_to_admin_handoff_without_streaming_the_answer(self):
        seen = {}

        class FakeClient:
            def request(self, method, path, *, query=None, body=None):
                seen.update(method=method, path=path, body=body)
                return {
                    "success": True,
                    "submitted": True,
                    "detached": True,
                    "conversation_url": "https://chatgpt.com/c/12345678-1234-1234-1234-1234567890ab",
                }

            def request_stream(self, *args, **kwargs):
                raise AssertionError("dispatch must not consume a completion stream")

        args = cli._parse_args(
            [
                "--json",
                "dispatch",
                "--spawner",
                "aiva",
                "--task",
                "detach smoke",
                "--model",
                "gpt-thinking",
                "Reply",
                "later",
            ]
        )
        result = cli._cmd_dispatch(FakeClient(), args)

        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["path"], "/admin/chatgpt/dispatch")
        self.assertEqual(seen["body"], {
            "model": "gpt-thinking",
            "prompt": "Reply later",
            "spawner": "aiva",
            "task": "detach smoke",
        })
        self.assertTrue(result["detached"])

    def test_bare_workers_lists_open_and_all_shows_closed(self):
        self.assertIsNone(cli._parse_args(["workers"]).workers_command)
        self.assertEqual(cli._parse_args(["workers", "all"]).workers_command, "all")
        close_args = cli._parse_args(
            ["workers", "close", "12345678-1234-1234-1234-1234567890ab", "--note", "smoke"]
        )
        self.assertEqual(close_args.workers_command, "close")
        self.assertEqual(close_args.note, "smoke")

    def test_worker_states_latest_line_wins_and_spawn_fields_survive_close(self):
        identifier = "12345678-1234-1234-1234-1234567890ab"
        spawn = {
            "ts": "2026-08-30T21:00:00.000Z",
            "conversation_id": identifier,
            "url": f"https://chatgpt.com/c/{identifier}",
            "spawner": "aiva",
            "task": "registry smoke test",
            "model": "gpt-thinking",
            "status": "open",
        }
        close = {"ts": "2026-08-30T21:05:00.000Z", "conversation_id": identifier, "status": "closed", "note": "smoke"}

        state = cli._worker_states([spawn, close])[0]
        self.assertEqual(state["status"], "closed")
        self.assertEqual(state["note"], "smoke")
        self.assertEqual(state["ts"], "2026-08-30T21:05:00.000Z")
        # The spawn attribution survives the close line.
        self.assertEqual(state["spawner"], "aiva")
        self.assertEqual(state["task"], "registry smoke test")

        reopened = cli._worker_states([spawn, close, {"ts": "2026-08-30T21:06:00.000Z", "conversation_id": identifier, "status": "open"}])
        self.assertEqual(reopened[0]["status"], "open")

        unknown_spawner = cli._worker_states([{"ts": "2026-08-30T21:00:00.000Z", "conversation_id": identifier, "status": "open"}])[0]
        self.assertEqual(unknown_spawner["spawner"], "unknown")
        self.assertEqual(unknown_spawner["url"], f"https://chatgpt.com/c/{identifier}")

    def test_worker_journal_reader_skips_malformed_lines(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "worker-registry.jsonl"
            path.write_text('not json\n\n{"conversation_id": "abc"}\n', encoding="utf-8")
            entries = cli._read_worker_lines(path)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["conversation_id"], "abc")

    def test_select_workers_filters_open_and_sorts_newest_first(self):
        old_open = {"conversation_id": "a", "status": "open", "ts": "2026-08-30T20:00:00Z"}
        closed = {"conversation_id": "b", "status": "closed", "ts": "2026-08-30T21:00:00Z"}
        new_open = {"conversation_id": "c", "status": "open", "ts": "2026-08-30T21:30:00Z"}
        open_only = cli._select_workers([old_open, closed, new_open], show_closed=False)
        self.assertEqual([worker["conversation_id"] for worker in open_only], ["c", "a"])
        everything = cli._select_workers([old_open, closed, new_open], show_closed=True)
        self.assertEqual([worker["conversation_id"] for worker in everything], ["c", "b", "a"])

    def test_workers_close_appends_without_rewriting_history(self):
        identifier = "12345678-1234-1234-1234-1234567890ab"
        spawn_line = json.dumps(
            {
                "ts": "2026-08-30T21:00:00.000Z",
                "conversation_id": identifier,
                "url": f"https://chatgpt.com/c/{identifier}",
                "spawner": "aiva",
                "status": "open",
            }
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "worker-registry.jsonl"
            path.write_text(spawn_line + "\n", encoding="utf-8")
            original_path = cli._worker_registry_path
            cli._worker_registry_path = lambda: path
            try:
                args = cli._parse_args(["workers", "close", identifier, "--note", "smoke"])
                cli._cmd_workers_close(args)
                lines = path.read_text(encoding="utf-8").splitlines()
            finally:
                cli._worker_registry_path = original_path
        self.assertEqual(lines[0], spawn_line)
        self.assertEqual(len(lines), 2)
        closing = json.loads(lines[1])
        self.assertEqual(closing["conversation_id"], identifier)
        self.assertEqual(closing["status"], "closed")
        self.assertEqual(closing["note"], "smoke")


if __name__ == "__main__":
    unittest.main()

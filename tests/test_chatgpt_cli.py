import importlib.machinery
import importlib.util
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


if __name__ == "__main__":
    unittest.main()

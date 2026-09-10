<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Modal, message } from 'ant-design-vue';
import {
  DashboardOutlined,
  SettingOutlined,
  ToolOutlined,
  PoweroffOutlined,
  GithubOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  InboxOutlined,
  PictureOutlined,
  HistoryOutlined,
  RocketOutlined,
  MenuOutlined
} from '@ant-design/icons-vue';
import { useSettingsStore } from '@/stores/settings';
import LoginModal from '@/components/auth/LoginModal.vue';

const router = useRouter();
const settingsStore = useSettingsStore();

const selectedKeys = ref(['dash']);
const collapsed = ref(false);
const isMobile = ref(false);
const loginVisible = ref(false);

const iconLoading = ref(false);
const enterIconLoading = () => {
  iconLoading.value = true;
  settingsStore.setToken('');
  setTimeout(() => {
    iconLoading.value = false;
    loginVisible.value = true;
  }, 500);
};

const menuRoutes = {
  'dash': '/',
  'history': '/tools/request',
  'settings-server': '/settings/server',
  'settings-workers': '/settings/workers',
  'settings-browser': '/settings/browser',
  'settings-adapters': '/settings/adapters',
  'tools-display': '/tools/display',
  'tools-cache': '/tools/cache',
  'tools-logs': '/tools/logs'
};

// 处理菜单点击
const handleMenuClick = ({ key }) => {
  const route = menuRoutes[key];
  if (route) {
    router.push(route);
    if (isMobile.value) collapsed.value = true;
  }
};

const isInitializing = ref(true);

// 后端连接检测
let connectionCheckInterval = null;
let disconnectModalShown = false;

async function checkConnection() {
  try {
    const res = await fetch('/admin/status', {
      headers: settingsStore.getHeaders(),
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok && disconnectModalShown) {
      // 连接恢复，刷新页面
      disconnectModalShown = false;
      Modal.destroyAll();
      window.location.reload();
    }
  } catch (e) {
    if (!disconnectModalShown && !isInitializing.value) {
      disconnectModalShown = true;
      Modal.warning({
        title: '后端连接断开',
        content: '无法连接到后端服务，请检查服务是否正在运行。连接恢复后页面将自动刷新。',
        okText: '我知道了',
        centered: true
      });
    }
  }
}

// 挂载时检查身份验证
onMounted(async () => {
  // 响应式侧边栏
  const checkScreenSize = () => {
    isMobile.value = window.innerWidth <= 768;
    if (isMobile.value) {
      collapsed.value = true;
    }
  };
  checkScreenSize();
  window.addEventListener('resize', checkScreenSize);

  // 身份验证
  try {
    if (!settingsStore.token) {
      loginVisible.value = true;
    } else {
      // 使用真实API验证
      const isValid = await settingsStore.checkAuth();
      if (!isValid) {
        settingsStore.setToken(''); // 清除无效token
        loginVisible.value = true;
      }
    }
  } catch (e) {
    console.error('Auth check failed', e);
    loginVisible.value = true;
  } finally {
    // 隐藏加载状态
    isInitializing.value = false;
  }

  // 启动后端连接检测（每 5 秒检测一次）
  connectionCheckInterval = setInterval(checkConnection, 5000);

  // 清理监听器
  onUnmounted(() => {
    window.removeEventListener('resize', checkScreenSize);
    if (connectionCheckInterval) {
      clearInterval(connectionCheckInterval);
    }
  });
});
</script>

<template>
  <a-spin :spinning="isInitializing" tip="正在验证身份..." size="large"
    style="height: 100vh; display: flex; align-items: center; justify-content: center;" v-if="isInitializing" />
  <div v-else>
    <LoginModal v-model:visible="loginVisible" />
    <a-layout style="min-height: 100vh" theme="light">
      <a-layout-header class="header"
        :style="{ background: 'rgba(255, 255, 255, 0.7)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '1.5px solid rgba(0, 0, 0, 0.05)', display: 'flex', alignItems: 'center', padding: isMobile ? '0 12px' : '0 24px', position: 'fixed', width: '100%', top: 0, zIndex: 1000 }">
        <a-button v-if="isMobile" type="text" @click="collapsed = !collapsed" style="margin-right: 8px; font-size: 18px;">
          <template #icon><MenuOutlined /></template>
        </a-button>
        <div class="logo" :style="{ fontSize: '1.25rem', fontWeight: 'bold', color: '#1890ff', marginRight: isMobile ? '8px' : '24px' }">
          WebAI2API
        </div>
        <a-flex justify="end" align="center" style="flex: 1;" :gap="8">

          <a-button danger :loading="iconLoading" @click="enterIconLoading" :size="isMobile ? 'small' : 'middle'">
            <template #icon>
              <PoweroffOutlined />
            </template>
            <span v-if="!isMobile">退出登录</span>
          </a-button>
        </a-flex>
      </a-layout-header>
      <a-layout style="margin-top: 64px;">
        <div v-if="isMobile && !collapsed" class="sider-mask" @click="collapsed = true"></div>
        <a-layout-sider v-model:collapsed="collapsed" collapsible theme="light"
          :collapsed-width="isMobile ? 0 : 80"
          :trigger="isMobile ? null : undefined"
          :style="{ position: 'fixed', left: 0, top: '64px', height: 'calc(100vh - 64px)', overflowY: 'auto', zIndex: isMobile ? 200 : 100 }">
          <a-menu v-model:selectedKeys="selectedKeys" mode="inline" @click="handleMenuClick">
            <a-menu-item key="dash">
              <DashboardOutlined />
              <span>状态概览</span>
            </a-menu-item>
            <a-menu-item key="history">
              <RocketOutlined />
              <span>请求历史</span>
            </a-menu-item>
            <a-sub-menu key="settings">
              <template #title>
                <span>
                  <SettingOutlined />
                  <span>系统设置</span>
                </span>
              </template>
              <a-menu-item key="settings-server">服务器</a-menu-item>
              <a-menu-item key="settings-workers">工作池</a-menu-item>
              <a-menu-item key="settings-browser">浏览器</a-menu-item>
              <a-menu-item key="settings-adapters">适配器</a-menu-item>
            </a-sub-menu>
            <a-sub-menu key="tools">
              <template #title>
                <span>
                  <ToolOutlined />
                  <span>系统管理</span>
                </span>
              </template>
              <a-menu-item key="tools-display">虚拟显示器</a-menu-item>
              <a-menu-item key="tools-cache">缓存与重启</a-menu-item>
              <a-menu-item key="tools-logs">日志查看器</a-menu-item>
            </a-sub-menu>
          </a-menu>
        </a-layout-sider>
        <a-layout
          :style="{ marginLeft: isMobile ? '0' : (collapsed ? '80px' : '200px'), padding: isMobile ? '12px' : '16px', transition: 'margin-left 0.2s' }">
          <a-layout-content style="min-height: 280px">
            <router-view />
          </a-layout-content>
          <a-layout-footer class="footer" style="padding: 0px; margin-top: 10px;">
            <a-card :bordered="false"
              :bodyStyle="{ padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }">
              <div>
                <a href="https://github.com/foxhui/WebAI2API" target="_blank" style="color: #8c8c8c; font-size: 20px;">
                  <GithubOutlined />
                </a>
              </div>
            </a-card>
          </a-layout-footer>
        </a-layout>
      </a-layout>
    </a-layout>


  </div>
</template>

<style scoped>
/* 滚动条美化 */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 3px;
}

::-webkit-scrollbar-track {
  background: #f1f1f1;
}

.sider-mask {
  position: fixed;
  top: 64px;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 199;
}
</style>

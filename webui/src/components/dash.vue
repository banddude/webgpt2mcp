<script setup>
import { ref, onMounted } from 'vue';
import { useSystemStore } from '@/stores/system';
import {
    DesktopOutlined,
    PieChartOutlined,
    ChromeOutlined,
    FieldTimeOutlined,
    LineChartOutlined,
    SyncOutlined,
    CheckCircleOutlined,
    CloseCircleOutlined
} from '@ant-design/icons-vue';

const systemStore = useSystemStore();
const refreshing = ref(false);
const refreshData = async () => {
    if (refreshing.value) return;
    refreshing.value = true;
    try {
        await Promise.all([systemStore.fetchStatus(), systemStore.fetchStats()]);
    } finally {
        refreshing.value = false;
    }
};

const formatUptime = (seconds) => {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}天 ${h}小时 ${m}分`;
    if (h > 0) return `${h}小时 ${m}分`;
    return `${m}分`;
};

const formatMemory = (mb) => {
    if (!mb || mb === 0) return '0 MB';
    if (mb > 1024) {
        return parseFloat((mb / 1024).toFixed(2)) + ' GB';
    }
    return parseFloat(Number(mb).toFixed(2)) + ' MB';
};

const getLoadColor = (usage) => {
    if (usage < 50) return '#52c41a'; // 绿色
    if (usage < 80) return '#faad14'; // 橙色
    return '#f5222d'; // 红色
};

// 状态映射
const getStatusConfig = (status) => {
    const map = {
        'normal': { color: 'green', text: '正常模式 (Normal)' },
        'headless': { color: 'blue', text: '无头模式 (Headless)' },
        'xvfb': { color: 'purple', text: '虚拟显示 (Xvfb)' }
    };
    return map[status] || { color: 'red', text: '未运行' };
};

onMounted(refreshData);
</script>

<template>
    <a-layout style="width: 100%; background: transparent;">
        <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
            <a-button @click="refreshData" :loading="refreshing">
                <template #icon><SyncOutlined /></template>
                刷新状态
            </a-button>
        </div>
        <!-- 安全模式告警横幅 -->
        <a-alert v-if="systemStore.safeMode?.enabled" type="error" show-icon style="margin-bottom: 16px;" closable>
            <template #message>
                <span style="font-weight: 600;">⚠️ 安全模式</span>
            </template>
            <template #description>
                <div>
                    <p style="margin-bottom: 8px;">
                        服务因初始化失败进入安全模式，浏览器控制不可用。
                    </p>
                    <p style="margin-bottom: 8px; color: #cf1322;">
                        <b>原因：</b>{{ systemStore.safeMode.reason }}
                    </p>
                    <p style="margin: 0;">
                        请前往「系统设置」修改正确的配置后重启服务。
                    </p>
                </div>
            </template>
        </a-alert>

        <!-- 响应式布局：手机竖向，电脑横向 -->
        <a-row :gutter="[16, 16]" style="margin-bottom: 24px">
            <!-- 系统信息卡片 -->
            <a-col :xs="24" :md="12">
                <a-card title="系统状态" :bordered="false" style="height: 100%">
                    <a-space direction="vertical" style="width: 100%" size="middle">
                        <div style="display: flex; justify-content: space-between;">
                            <span>
                                <DesktopOutlined /> 系统版本:
                            </span>
                            <b>{{ systemStore.systemVersion }}</b>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>
                                <FieldTimeOutlined /> 运行时间:
                            </span>
                            <b>{{ formatUptime(systemStore.uptime) }}</b>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>
                                <ChromeOutlined /> 状态:
                            </span>
                            <a-tag :color="getStatusConfig(systemStore.status).color">
                                {{ getStatusConfig(systemStore.status).text }}
                            </a-tag>
                        </div>

                        <div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <span>
                                    <LineChartOutlined /> CPU 使用率:
                                </span>
                                <span>{{ systemStore.cpuUsage }}%</span>
                            </div>
                            <a-progress :percent="systemStore.cpuUsage"
                                :stroke-color="getLoadColor(systemStore.cpuUsage)" :show-info="false" />
                        </div>

                        <div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <span>
                                    <PieChartOutlined /> 内存使用:
                                </span>
                                <span>{{ formatMemory(systemStore.memoryUsage.used) }} / {{
                                    formatMemory(systemStore.memoryUsage.total) }}</span>
                            </div>
                            <a-progress
                                :percent="Math.round((systemStore.memoryUsage.used / systemStore.memoryUsage.total) * 100) || 0"
                                :stroke-color="getLoadColor((systemStore.memoryUsage.used / systemStore.memoryUsage.total) * 100)"
                                :show-info="false" />
                        </div>
                    </a-space>
                </a-card>
            </a-col>

            <!-- 统计数据卡片 -->
            <a-col :xs="24" :md="12">
                <a-card title="浏览器与历史统计" :bordered="false" style="height: 100%">
                    <a-row :gutter="16" style="margin-bottom: 24px">
                        <a-col :span="12">
                            <a-statistic title="窗口数量" :value="systemStore.stats.workers || 0">
                                <template #suffix>
                                    <span style="font-size: 14px; color: #8c8c8c;">个</span>
                                </template>
                            </a-statistic>
                        </a-col>
                        <a-col :span="12">
                            <a-statistic title="实例数量" :value="systemStore.stats.instances || 0">
                                <template #suffix>
                                    <span style=" font-size: 14px; color: #8c8c8c;">个</span>
                                </template>
                            </a-statistic>
                        </a-col>
                    </a-row>
                    <a-row :gutter="16" style="margin-top: 16px">
                        <a-col :span="12">
                            <a-statistic title="今日成功" :value="systemStore.stats.success || 0">
                                <template #prefix>
                                    <CheckCircleOutlined style="color: #52c41a" />
                                </template>
                            </a-statistic>
                        </a-col>
                        <a-col :span="12">
                            <a-statistic title="今日失败" :value="systemStore.stats.failed || 0">
                                <template #prefix>
                                    <CloseCircleOutlined style="color: #ff4d4f" />
                                </template>
                            </a-statistic>
                        </a-col>
                    </a-row>
                </a-card>
            </a-col>
        </a-row>

    </a-layout>
</template>
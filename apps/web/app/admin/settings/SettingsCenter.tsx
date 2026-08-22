'use client';

import type { SettingsSection } from './SettingsNav';
import { SettingsHeader } from './SettingsNav';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import SecuritySettingsPanel from './SecuritySettingsPanel';
import IntegrationsSettingsPanel from './IntegrationsSettingsPanel';
import InfrastructureSettingsPanel from './InfrastructureSettingsPanel';

const copy: Record<SettingsSection, { title: string; description: string }> = {
  general: { title: '常规设置', description: '管理站点公开呈现和写作默认值；保存失败时会保留当前表单内容。' },
  security: { title: '安全设置', description: '修改密码、轮换恢复密钥并管理当前登录设备。Secret 只显示状态，不显示内容。' },
  integrations: { title: '集成设置', description: '只配置项目已经接入的外部图床和 NAS pull 策略，不提供未接入服务的空表单。' },
  infrastructure: { title: '运行状态', description: '只读查看媒体、外部能力和安全边界状态，不从后台读取基础设施根凭证。' },
};

export default function SettingsCenter({ section }: { section: SettingsSection }) {
  const sectionCopy = copy[section];
  return <main id="main-content" className="shell settings-center"><SettingsHeader section={section} title={sectionCopy.title} description={sectionCopy.description} />{section === 'general' ? <GeneralSettingsPanel /> : section === 'security' ? <SecuritySettingsPanel /> : section === 'integrations' ? <IntegrationsSettingsPanel /> : <InfrastructureSettingsPanel />}</main>;
}

import { PageHeader } from "@/components/page";
import { RequirePermission } from "@/components/people/shared";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequirePermission permission="settings:manage" title="Settings">
      <PageHeader
        title="Settings"
        description="How the store presents itself, ships, and charges tax."
      />
      <SettingsTabs />
      {children}
    </RequirePermission>
  );
}

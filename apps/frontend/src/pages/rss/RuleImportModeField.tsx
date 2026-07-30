import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export type RuleImportMode = 'legacy_direct' | 'managed_intake';

/**
 * How a rule's downloads reach the library.
 *
 * The two modes are genuinely different pipelines, so the control says what
 * each one does rather than offering two words the reader has to guess between.
 * The description under the select changes with the choice, because the
 * consequence — where files land, and whether a torrent keeps seeding — is the
 * thing being chosen, not the label.
 *
 * A managed rule needs somewhere to stage. When no storage profile exists the
 * field says so and links to where one is made, rather than letting an operator
 * select a mode that will log a warning and quietly do nothing on the next
 * completed download. That failure — enabled but inert — has caught this
 * project out twice already.
 */
export function RuleImportModeField({
  value,
  profileId,
  onChange,
  onProfileChange,
  disabled,
}: {
  value: RuleImportMode;
  profileId: string | null;
  onChange: (mode: RuleImportMode) => void;
  onProfileChange: (profileId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('rss');
  const managed = value === 'managed_intake';

  const profiles = useQuery({
    queryKey: ['intake', 'profiles'],
    queryFn: () => api.intake.profiles(),
    // Only asked for when it can matter.
    enabled: managed,
  });

  const available = profiles.data ?? [];

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor="rule-import-mode">{t('rule.importMode.label')}</Label>
        <Select
          id="rule-import-mode"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as RuleImportMode)}
          options={[
            { value: 'managed_intake', label: t('rule.importMode.managed') },
            { value: 'legacy_direct', label: t('rule.importMode.legacy') },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {managed ? t('rule.importMode.managedHelp') : t('rule.importMode.legacyHelp')}
        </p>
      </div>

      {managed && (
        <div className="space-y-1.5">
          <Label htmlFor="rule-storage-profile">{t('rule.importMode.profile')}</Label>
          <Select
            id="rule-storage-profile"
            value={profileId ?? ''}
            disabled={disabled || !available.length}
            onChange={(e) => onProfileChange(e.target.value || null)}
            options={[
              { value: '', label: t('rule.importMode.profileDefault') },
              ...available.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {/* Managed with nowhere to stage does nothing at all — say so here,
              not in a log line nobody reads. */}
          {profiles.isSuccess && !available.length && (
            <p className="text-xs text-amber-500">
              {t('rule.importMode.noProfiles')}{' '}
              <Link to="/media/settings" className="underline">
                {t('rule.importMode.createProfile')}
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

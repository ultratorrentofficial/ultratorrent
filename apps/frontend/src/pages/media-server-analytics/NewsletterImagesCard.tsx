import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Image as ImageIcon } from 'lucide-react';
import { api, ApiError, type PosterHostingMode } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

const MODES: PosterHostingMode[] = ['attach', 'self_hosted', 'external'];

/**
 * How newsletter posters reach the inbox — embedded attachments (self-contained),
 * served from this instance (signed public URLs, no attachments), or uploaded to
 * an external image host. Self-contained on the Settings page.
 */
export function NewsletterImagesCard() {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const q = useQuery({ queryKey: ['msa', 'newsletter-images'], queryFn: () => api.mediaServerAnalytics.newsletterImageSettings() });
  const [form, setForm] = useState({ mode: 'attach' as PosterHostingMode, publicBaseUrl: '', imgurClientId: '' });
  useEffect(() => {
    if (q.data) setForm((f) => ({ ...f, mode: q.data.mode, publicBaseUrl: q.data.publicBaseUrl }));
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.mediaServerAnalytics.updateNewsletterImageSettings({
      mode: form.mode,
      publicBaseUrl: form.publicBaseUrl,
      ...(form.imgurClientId.trim() ? { imgurClientId: form.imgurClientId.trim() } : {}),
    }),
    onSuccess: () => { setForm((f) => ({ ...f, imgurClientId: '' })); toast.success(t('newsletter.images.saved')); },
    onError: (e) => toast.error(t('newsletter.images.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><ImageIcon className="h-4 w-4" />{t('newsletter.images.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('newsletter.images.subtitle')}</p>

        <div className="space-y-2">
          {MODES.map((m) => (
            <label key={m} className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 p-2.5 hover:bg-white/5">
              <input
                type="radio"
                name="poster-mode"
                className="mt-0.5 accent-amber-400"
                checked={form.mode === m}
                onChange={() => setForm((f) => ({ ...f, mode: m }))}
              />
              <span className="text-sm">
                <span className="font-medium">{t(`newsletter.images.mode.${m}.label`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`newsletter.images.mode.${m}.desc`)}</span>
              </span>
            </label>
          ))}
        </div>

        {form.mode === 'self_hosted' && (
          <div className="space-y-1.5">
            <Label htmlFor="nl-base">{t('newsletter.images.publicBaseUrl')}</Label>
            <Input id="nl-base" value={form.publicBaseUrl} onChange={(e) => setForm((f) => ({ ...f, publicBaseUrl: e.target.value }))} placeholder="http://your-host:65080" />
            <p className="text-xs text-muted-foreground">{t('newsletter.images.publicBaseUrlHint')}</p>
          </div>
        )}

        {form.mode === 'external' && (
          <div className="space-y-1.5">
            <Label htmlFor="nl-imgur">{t('newsletter.images.imgurClientId')}</Label>
            <Input id="nl-imgur" type="password" value={form.imgurClientId} placeholder={q.data?.hasImgurClientId ? '••••••••' : ''} onChange={(e) => setForm((f) => ({ ...f, imgurClientId: e.target.value }))} />
            <p className="text-xs text-muted-foreground">{t('newsletter.images.imgurClientIdHint')}</p>
          </div>
        )}

        <Button onClick={() => save.mutate()} disabled={save.isPending}>{t('newsletter.images.save')}</Button>
      </CardContent>
    </Card>
  );
}

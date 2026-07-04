import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation('system');
  return (
    <div className="grid min-h-[60vh] place-items-center px-6 text-center">
      <div className="space-y-4">
        <p className="text-6xl font-bold text-gradient">{t('notFound.code')}</p>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t('notFound.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('notFound.description')}</p>
        </div>
        <Button onClick={() => navigate('/dashboard')}>{t('notFound.backToDashboard')}</Button>
      </div>
    </div>
  );
}

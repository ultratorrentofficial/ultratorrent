import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthProvider } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { RealtimeProvider } from '@/realtime/RealtimeContext';
import { ModuleProvider } from '@/modules/ModuleContext';
import { ModuleRoute } from '@/modules/ModuleRoute';
import { ToastProvider } from '@/components/ui/toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { TorrentsPage } from '@/pages/TorrentsPage';
import { RssPage } from '@/pages/RssPage';
import { RssRulePage } from '@/pages/RssRulePage';
import { RssFeedHistoryPage } from '@/pages/RssFeedHistoryPage';
import { UsersPage } from '@/pages/UsersPage';
import { MediaPage } from '@/pages/MediaPage';
import { MediaDashboardPage } from '@/pages/media-manager/MediaDashboardPage';
import { MediaLibrariesPage } from '@/pages/media-manager/MediaLibrariesPage';
import { MediaItemsPage } from '@/pages/media-manager/MediaItemsPage';
import { MediaDetailPage } from '@/pages/media-manager/MediaDetailPage';
import { MediaUnmatchedPage } from '@/pages/media-manager/MediaUnmatchedPage';
import { MediaDuplicatesPage } from '@/pages/media-manager/MediaDuplicatesPage';
import { MediaRenamePreviewPage } from '@/pages/media-manager/MediaRenamePreviewPage';
import { MediaSettingsPage } from '@/pages/media-manager/MediaSettingsPage';
import { MediaImdbSettingsPage } from '@/pages/media-manager/MediaImdbSettingsPage';
import { ModulesPage } from '@/pages/ModulesPage';
import { EnginesPage } from '@/pages/engines/EnginesPage';
import { MediaAcquisitionPage } from '@/pages/media-acquisition/MediaAcquisitionPage';
import { MissingEpisodesPage } from '@/pages/media-acquisition/MissingEpisodesPage';
import { ReleaseScoringPage } from '@/pages/release-scoring/ReleaseScoringPage';
import { AutomationPage } from '@/pages/AutomationPage';
import { FilesPage } from '@/pages/FilesPage';
import { AuditPage } from '@/pages/AuditPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { NotFoundPage } from '@/pages/NotFoundPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5000,
    },
  },
});

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <AuthProvider>
              <RealtimeProvider>
                <ModuleProvider>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />

                  {/* Authenticated application shell */}
                  <Route element={<ProtectedRoute />}>
                    <Route element={<AppShell />}>
                      <Route index element={<Navigate to="/dashboard" replace />} />
                      <Route path="/dashboard" element={<DashboardPage />} />
                      <Route path="/account" element={<ProfilePage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.TORRENTS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/torrents" element={<TorrentsPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.SYSTEM_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/engines" element={<EnginesPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.RSS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/rss" element={<RssPage />} />
                      <Route path="/rss/rules/:ruleId" element={<RssRulePage />} />
                      <Route path="/rss/feeds/:feedId/history" element={<RssFeedHistoryPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.AUTOMATION_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/automation" element={<AutomationPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.FILES_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/files" element={<FilesPage />} />
                    </Route>
                  </Route>

                  {/* Media Manager — core module `media_manager`. */}
                  <Route element={<ProtectedRoute permission={PERMISSIONS.MEDIA_MANAGER_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route
                        path="/media"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaDashboardPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/libraries"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaLibrariesPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/items"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaItemsPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/items/:id"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaDetailPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/unmatched"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaUnmatchedPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/duplicates"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaDuplicatesPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/rename-preview"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaRenamePreviewPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/settings"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaSettingsPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media/settings/imdb"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaImdbSettingsPage />
                          </ModuleRoute>
                        }
                      />
                      {/* Rename engine (preview/apply/history + dry-run/jobs/templates). */}
                      <Route
                        path="/media/rename"
                        element={
                          <ModuleRoute moduleId="media_manager">
                            <MediaPage />
                          </ModuleRoute>
                        }
                      />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.USERS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/users" element={<UsersPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.AUDIT_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/audit" element={<AuditPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.SETTINGS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/settings" element={<SettingsPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.MODULES_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/modules" element={<ModulesPage />} />
                    </Route>
                  </Route>

                  {/* Media renaming is served by the unified MediaPage at `/media`
                      (Libraries + Quick Rename + Dry Run + Jobs + Templates +
                      History) via the `media_manager` module. */}

                  {/* Media Acquisition — `media_acquisition_intelligence` module. */}
                  <Route element={<ProtectedRoute permission={PERMISSIONS.MEDIA_ACQUISITION_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route
                        path="/media-acquisition"
                        element={
                          <ModuleRoute moduleId="media_acquisition_intelligence">
                            <MediaAcquisitionPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-acquisition/missing-episodes"
                        element={
                          <ModuleRoute moduleId="media_acquisition_intelligence">
                            <MissingEpisodesPage />
                          </ModuleRoute>
                        }
                      />
                    </Route>
                  </Route>

                  {/* Release Scoring — core module `release_scoring`. */}
                  <Route element={<ProtectedRoute permission={PERMISSIONS.RELEASE_SCORING_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route
                        path="/release-scoring"
                        element={
                          <ModuleRoute moduleId="release_scoring">
                            <ReleaseScoringPage />
                          </ModuleRoute>
                        }
                      />
                    </Route>
                  </Route>

                  {/* Catch-all */}
                  <Route element={<ProtectedRoute />}>
                    <Route element={<AppShell />}>
                      <Route path="*" element={<NotFoundPage />} />
                    </Route>
                  </Route>
                </Routes>
                </ModuleProvider>
              </RealtimeProvider>
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

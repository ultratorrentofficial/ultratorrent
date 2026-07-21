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
import { ModuleHubPage } from '@/pages/ModuleHubPage';
import { JobsCenterPage } from '@/pages/jobs/JobsCenterPage';
import { JobsOverviewPage } from '@/pages/jobs/JobsOverviewPage';
import { JobsListPage } from '@/pages/jobs/JobsListPage';
import { JobDetailPage } from '@/pages/jobs/JobDetailPage';
import { TorrentsPage } from '@/pages/TorrentsPage';
import { RssPage } from '@/pages/RssPage';
import { RssRulePage } from '@/pages/RssRulePage';
import { RssFeedHistoryPage } from '@/pages/RssFeedHistoryPage';
import { UsersPage } from '@/pages/UsersPage';
import { MediaPage } from '@/pages/MediaPage';
import { MediaDashboardPage } from '@/pages/media-manager/MediaDashboardPage';
import { SubtitleDashboardPage } from '@/pages/subtitle-intelligence/SubtitleDashboardPage';
import { SubtitleProvidersPage } from '@/pages/subtitle-intelligence/SubtitleProvidersPage';
import { SubtitleSearchPage } from '@/pages/subtitle-intelligence/SubtitleSearchPage';
import { SubtitleSyncPage } from '@/pages/subtitle-intelligence/SubtitleSyncPage';
import { SubtitleValidationPage } from '@/pages/subtitle-intelligence/SubtitleValidationPage';
import { SubtitleLanguagesPage } from '@/pages/subtitle-intelligence/SubtitleLanguagesPage';
import { SubtitleHistoryPage } from '@/pages/subtitle-intelligence/SubtitleHistoryPage';
import { SubtitleSettingsPage } from '@/pages/subtitle-intelligence/SubtitleSettingsPage';
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
import { IndexersPage } from '@/pages/indexers/IndexersPage';
import { MediaAcquisitionPage } from '@/pages/media-acquisition/MediaAcquisitionPage';
import { MissingEpisodesPage } from '@/pages/media-acquisition/MissingEpisodesPage';
import { DecisionSimulatorPage } from '@/pages/media-acquisition/DecisionSimulatorPage';
import { SmartDownloadDashboardPage } from '@/pages/media-acquisition/SmartDownloadDashboardPage';
import { MediaServerAnalyticsDashboardPage } from '@/pages/media-server-analytics/MediaServerAnalyticsDashboardPage';
import { MediaServerConnectionsPage } from '@/pages/media-server-analytics/MediaServerConnectionsPage';
import { LiveActivityPage } from '@/pages/media-server-analytics/LiveActivityPage';
import { WatchHistoryPage } from '@/pages/media-server-analytics/WatchHistoryPage';
import { ReportsPage } from '@/pages/media-server-analytics/ReportsPage';
import { RecentlyAddedPage } from '@/pages/media-server-analytics/RecentlyAddedPage';
import { ImportAnalyticsPage } from '@/pages/media-server-analytics/ImportAnalyticsPage';
import { NewslettersPage } from '@/pages/media-server-analytics/NewslettersPage';
import { NotificationDashboardPage } from '@/pages/notification-center/NotificationDashboardPage';
import { NotificationChannelsPage } from '@/pages/notification-center/NotificationChannelsPage';
import { NotificationRulesPage } from '@/pages/notification-center/NotificationRulesPage';
import { NotificationRecipientsPage } from '@/pages/notification-center/NotificationRecipientsPage';
import { NotificationHistoryPage } from '@/pages/notification-center/NotificationHistoryPage';
import { NotificationTemplatesPage } from '@/pages/notification-center/NotificationTemplatesPage';
import { NotificationGroupsPage } from '@/pages/notification-center/NotificationGroupsPage';
import { NotificationQueuePage } from '@/pages/notification-center/NotificationQueuePage';
import { NotificationProviderHealthPage } from '@/pages/notification-center/NotificationProviderHealthPage';
import { NotificationPreferencesPage } from '@/pages/notification-center/NotificationPreferencesPage';
import { NotificationSettingsPage } from '@/pages/notification-center/NotificationSettingsPage';
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
                      <Route path="/hub/:domainId" element={<ModuleHubPage />} />
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

                  <Route element={<ProtectedRoute permission={PERMISSIONS.INDEXERS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/indexers" element={<IndexersPage />} />
                    </Route>
                  </Route>

                  <Route element={<ProtectedRoute permission={PERMISSIONS.JOBS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/jobs" element={<JobsCenterPage />}>
                        <Route index element={<JobsOverviewPage />} />
                        <Route path="list" element={<JobsListPage />} />
                        <Route path=":id" element={<JobDetailPage />} />
                      </Route>
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

                  {/* Subtitle Intelligence — core module `subtitle_intelligence`. */}
                  <Route element={<ProtectedRoute permission={PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route
                        path="/subtitles"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleDashboardPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/search"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleSearchPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/providers"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleProvidersPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/sync"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleSyncPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/validation"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleValidationPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/languages"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleLanguagesPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/history"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleHistoryPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/subtitles/settings"
                        element={
                          <ModuleRoute moduleId="subtitle_intelligence">
                            <SubtitleSettingsPage />
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
                      <Route
                        path="/media-acquisition/simulator"
                        element={
                          <ModuleRoute moduleId="media_acquisition_intelligence">
                            <DecisionSimulatorPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-acquisition/dashboard"
                        element={
                          <ModuleRoute moduleId="media_acquisition_intelligence">
                            <SmartDownloadDashboardPage />
                          </ModuleRoute>
                        }
                      />
                    </Route>
                  </Route>

                  {/* Media Server Analytics — module `media_server_analytics`. */}
                  <Route element={<ProtectedRoute permission={PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route
                        path="/media-server-analytics"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <MediaServerAnalyticsDashboardPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/connections"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <MediaServerConnectionsPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/live"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <LiveActivityPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/watch-history"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <WatchHistoryPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/recently-added"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <RecentlyAddedPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/reports"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <ReportsPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/import"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <ImportAnalyticsPage />
                          </ModuleRoute>
                        }
                      />
                      <Route
                        path="/media-server-analytics/newsletters"
                        element={
                          <ModuleRoute moduleId="media_server_analytics">
                            <NewslettersPage />
                          </ModuleRoute>
                        }
                      />
                    </Route>
                  </Route>

                  {/* Notification Center — core module `notification_center`. */}
                  <Route element={<ProtectedRoute permission={PERMISSIONS.NOTIFICATIONS_VIEW} />}>
                    <Route element={<AppShell />}>
                      <Route path="/notifications" element={<ModuleRoute moduleId="notification_center"><NotificationDashboardPage /></ModuleRoute>} />
                      <Route path="/notifications/channels" element={<ModuleRoute moduleId="notification_center"><NotificationChannelsPage /></ModuleRoute>} />
                      <Route path="/notifications/rules" element={<ModuleRoute moduleId="notification_center"><NotificationRulesPage /></ModuleRoute>} />
                      <Route path="/notifications/recipients" element={<ModuleRoute moduleId="notification_center"><NotificationRecipientsPage /></ModuleRoute>} />
                      <Route path="/notifications/groups" element={<ModuleRoute moduleId="notification_center"><NotificationGroupsPage /></ModuleRoute>} />
                      <Route path="/notifications/templates" element={<ModuleRoute moduleId="notification_center"><NotificationTemplatesPage /></ModuleRoute>} />
                      <Route path="/notifications/history" element={<ModuleRoute moduleId="notification_center"><NotificationHistoryPage /></ModuleRoute>} />
                      <Route path="/notifications/queue" element={<ModuleRoute moduleId="notification_center"><NotificationQueuePage /></ModuleRoute>} />
                      <Route path="/notifications/provider-health" element={<ModuleRoute moduleId="notification_center"><NotificationProviderHealthPage /></ModuleRoute>} />
                      <Route path="/notifications/preferences" element={<ModuleRoute moduleId="notification_center"><NotificationPreferencesPage /></ModuleRoute>} />
                      <Route path="/notifications/settings" element={<ModuleRoute moduleId="notification_center"><NotificationSettingsPage /></ModuleRoute>} />
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

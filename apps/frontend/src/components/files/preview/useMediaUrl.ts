import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A URL an `<img>`, `<video>` or `<iframe>` can load for a file under the file
 * manager's root.
 *
 * The app authenticates with a bearer token held in memory, and none of those
 * elements can send one — so the backend mints a short-lived, single-path ticket
 * and the URL carries it. Fetching the bytes into a blob instead would work for
 * a photo and fall apart for video: a blob has to arrive whole before it plays,
 * which forfeits both seeking and any chance of watching a 40 GB file.
 *
 * Cached per path for an hour, comfortably inside the ticket's own lifetime, so
 * paging back and forth through a folder does not re-mint on every step.
 */
export function useMediaUrl(path: string | null | undefined, enabled = true) {
  const query = useQuery({
    queryKey: ['file-media-ticket', path],
    queryFn: () => api.files.mediaTicket(path as string),
    enabled: enabled && !!path,
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
  return {
    url: query.data ? api.files.streamUrl(query.data) : null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

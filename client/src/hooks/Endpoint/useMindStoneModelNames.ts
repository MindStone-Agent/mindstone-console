import { useQuery } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';

/** The Console's gateway endpoint, as named in mindstone/librechat.yaml. */
export const MINDSTONE_ENDPOINT = 'MindStone';

/**
 * Display names for MindStone's models (#53): each agent is listed as
 * mindstone/<agentId>, and the model menu shows the agent's name instead.
 * Any signed-in user may read them; a failure just leaves the ids.
 */
export default function useMindStoneModelNames(enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['mindstoneModelNames'],
    queryFn: () => request.get<{ names: Record<string, string> }>('/api/mindstone-model-names'),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  return data?.names;
}

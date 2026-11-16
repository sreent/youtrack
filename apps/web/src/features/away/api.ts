/**
 * Days away (docs/architecture.md, D36), and the load grid's window. Days away move plans, so a
 * change to them reads every plan again (keys starting 'plan') along with the person's list.
 */
import type { Absence, CreateAbsenceInput, LoadWindow, Preferences, UpdateAbsenceInput } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../../api/client';

export const awayKeys = {
  all: ['absences'] as const,
  of: (login: string) => ['absences', login] as const,
  preferences: ['preferences'] as const,
};

export function useAbsences(login: string | null) {
  return useQuery({
    queryKey: awayKeys.of(login ?? ''),
    queryFn: () => get<Absence[]>(`/absences${qs({ user: login ?? undefined })}`),
    enabled: Boolean(login),
  });
}

/** Add, change and remove days away; each reads the plans again. */
export function useAbsenceChanges() {
  const qc = useQueryClient();
  const changed = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: awayKeys.all }), qc.invalidateQueries({ queryKey: ['plan'] })]);
  };
  return {
    add: useMutation({ mutationFn: (input: CreateAbsenceInput) => post<Absence>('/absences', input), onSuccess: changed }),
    change: useMutation({ mutationFn: ({ id, ...input }: UpdateAbsenceInput & { id: string }) => patch<Absence>(`/absences/${id}`, input), onSuccess: changed }),
    remove: useMutation({ mutationFn: (id: string) => del(`/absences/${id}`), onSuccess: changed }),
  };
}

export function usePreferences() {
  return useQuery({ queryKey: awayKeys.preferences, queryFn: () => get<Preferences>('/me/preferences'), staleTime: 60_000 });
}

/** Keeps the person's choice of window for them, on every device; the grid follows at once. */
export function useSetLoadWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (loadWindow: LoadWindow | null) => patch<Preferences>('/me/preferences', { loadWindow }),
    onMutate: (loadWindow) => {
      const before = qc.getQueryData<Preferences>(awayKeys.preferences);
      qc.setQueryData<Preferences>(awayKeys.preferences, { ...(before ?? { loadWindow: null }), loadWindow });
      return { before };
    },
    onError: (_e, _w, context) => qc.setQueryData(awayKeys.preferences, context?.before),
    onSuccess: (p) => qc.setQueryData(awayKeys.preferences, p),
  });
}

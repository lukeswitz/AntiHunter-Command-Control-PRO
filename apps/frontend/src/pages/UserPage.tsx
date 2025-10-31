import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import type {
  AuditEntry,
  AuthUser,
  FeatureFlagDefinition,
  SiteAccessLevel,
  SiteSummary,
  UserDetail,
  UserRole,
  UserSiteAccessGrant,
} from '../api/types';
import { useTheme } from '../providers/theme-provider';
import { useAuthStore } from '../stores/auth-store';

type ThemePreference = 'light' | 'dark' | 'auto';
type DensityPreference = 'compact' | 'comfortable';
type TimeFormatPreference = '12h' | '24h';

interface ProfileFormState {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  jobTitle: string;
  theme: ThemePreference;
  density: DensityPreference;
  language: string;
  timeFormat: TimeFormatPreference;
}

interface CreateUserFormState {
  email: string;
  password: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  timeFormat: TimeFormatPreference;
}

interface ManageFormState {
  firstName: string;
  lastName: string;
  phone: string;
  jobTitle: string;
  timeFormat: TimeFormatPreference;
  password: string;
}

interface UpdateUserDtoPayload {
  email?: string;
  role?: UserRole;
  isActive?: boolean;
  firstName?: string;
  lastName?: string;
  phone?: string;
  jobTitle?: string;
  timeFormat?: TimeFormatPreference;
  password?: string;
}

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'no', label: 'Norwegian' },
];

export function UserPage() {
  const queryClient = useQueryClient();
  const authUser = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const { setTheme } = useTheme();

  const meQuery = useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => apiClient.get<AuthUser>('/users/me'),
  });

  const [profileForm, setProfileForm] = useState<ProfileFormState | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!meQuery.data) {
      return;
    }
    const prefs = meQuery.data.preferences;
    setProfileForm({
      email: meQuery.data.email,
      firstName: meQuery.data.firstName ?? '',
      lastName: meQuery.data.lastName ?? '',
      phone: meQuery.data.phone ?? '',
      jobTitle: meQuery.data.jobTitle ?? '',
      theme: (prefs.theme as ThemePreference) ?? 'auto',
      density: (prefs.density as DensityPreference) ?? 'compact',
      language: prefs.language ?? 'en',
      timeFormat: (prefs.timeFormat as TimeFormatPreference) ?? '24h',
    });
  }, [meQuery.data]);

  useEffect(() => {
    const preferred = profileForm?.theme ?? 'auto';
    if (preferred === 'dark' || preferred === 'light') {
      setTheme(preferred);
      return;
    }
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }, [profileForm?.theme, setTheme]);

  const updateProfileMutation = useMutation({
    mutationFn: (payload: Partial<ProfileFormState>) =>
      apiClient.put<AuthUser>('/users/me', payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['users', 'me'], data);
      setAuthUser(data);
      const prefs = data.preferences;
      setProfileForm({
        email: data.email,
        firstName: data.firstName ?? '',
        lastName: data.lastName ?? '',
        phone: data.phone ?? '',
        jobTitle: data.jobTitle ?? '',
        theme: (prefs.theme as ThemePreference) ?? 'auto',
        density: (prefs.density as DensityPreference) ?? 'compact',
        language: prefs.language ?? 'en',
        timeFormat: (prefs.timeFormat as TimeFormatPreference) ?? '24h',
      });
      setProfileMessage('Profile updated successfully.');
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update profile. Please try again.';
      setProfileMessage(message);
    },
  });

  const handleProfileSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!profileForm) {
      return;
    }
    setProfileMessage(null);
    updateProfileMutation.mutate(profileForm);
  };

  const canManageUsers = authUser?.role === 'ADMIN';

  const layoutClass = canManageUsers ? 'account-layout account-layout--admin' : 'account-layout';

  return (
    <div className={layoutClass}>
      <section className="panel account-profile">
        <header className="panel__header">
          <div>
            <h1 className="panel__title">My Profile</h1>
            <p className="panel__subtitle">
              Update your account details and interface preferences.
            </p>
          </div>
        </header>

        {!profileForm ? (
          <div className="empty-state">
            <div>Loading profile...</div>
          </div>
        ) : (
          <form className="form-grid" onSubmit={handleProfileSubmit}>
            <label>
              <span>Email</span>
              <input
                className="control-input"
                type="email"
                value={profileForm.email}
                onChange={(event) =>
                  setProfileForm((prev) => prev && { ...prev, email: event.target.value })
                }
              />
            </label>
            <label>
              <span>First Name</span>
              <input
                className="control-input"
                value={profileForm.firstName}
                onChange={(event) =>
                  setProfileForm((prev) => prev && { ...prev, firstName: event.target.value })
                }
              />
            </label>
            <label>
              <span>Last Name</span>
              <input
                className="control-input"
                value={profileForm.lastName}
                onChange={(event) =>
                  setProfileForm((prev) => prev && { ...prev, lastName: event.target.value })
                }
              />
            </label>
            <label>
              <span>Phone</span>
              <input
                className="control-input"
                value={profileForm.phone}
                onChange={(event) =>
                  setProfileForm((prev) => prev && { ...prev, phone: event.target.value })
                }
              />
            </label>
            <label>
              <span>Job Title</span>
              <input
                className="control-input"
                value={profileForm.jobTitle}
                onChange={(event) =>
                  setProfileForm((prev) => prev && { ...prev, jobTitle: event.target.value })
                }
              />
            </label>
            <label>
              <span>Theme</span>
              <select
                className="control-input"
                value={profileForm.theme}
                onChange={(event) =>
                  setProfileForm(
                    (prev) => prev && { ...prev, theme: event.target.value as ThemePreference },
                  )
                }
              >
                <option value="auto">Auto</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label>
              <span>Interface Density</span>
              <select
                className="control-input"
                value={profileForm.density}
                onChange={(event) =>
                  setProfileForm(
                    (prev) => prev && { ...prev, density: event.target.value as DensityPreference },
                  )
                }
              >
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
              </select>
            </label>
            <label>
              <span>Language</span>
              <select
                className="control-input"
                value={profileForm.language}
                onChange={(event) =>
                  setProfileForm((prev) => prev && { ...prev, language: event.target.value })
                }
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Time Format</span>
              <select
                className="control-input"
                value={profileForm.timeFormat}
                onChange={(event) =>
                  setProfileForm(
                    (prev) =>
                      prev && {
                        ...prev,
                        timeFormat: event.target.value as TimeFormatPreference,
                      },
                  )
                }
              >
                <option value="24h">24-hour</option>
                <option value="12h">12-hour</option>
              </select>
            </label>
            <div className="form-row form-row--actions">
              <button
                type="submit"
                className="submit-button"
                disabled={updateProfileMutation.isPending}
              >
                {updateProfileMutation.isPending ? 'Saving...' : 'Save Profile'}
              </button>
              {profileMessage ? <span className="form-feedback">{profileMessage}</span> : null}
            </div>
          </form>
        )}
      </section>

      {canManageUsers ? <AdminUserManagement /> : null}
    </div>
  );
}

function AdminUserManagement() {
  const queryClient = useQueryClient();
  const authUser = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);

  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [createForm, setCreateForm] = useState<CreateUserFormState>({
    email: '',
    password: '',
    role: 'OPERATOR',
    firstName: '',
    lastName: '',
    timeFormat: '24h',
  });
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [managedUser, setManagedUser] = useState<AuthUser | null>(null);
  const [manageForm, setManageForm] = useState<ManageFormState>({
    firstName: '',
    lastName: '',
    phone: '',
    jobTitle: '',
    timeFormat: '24h',
    password: '',
  });
  const [manageMessage, setManageMessage] = useState<string | null>(null);
  const [permissionsMessage, setPermissionsMessage] = useState<string | null>(null);
  const [siteMessage, setSiteMessage] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [featureSelection, setFeatureSelection] = useState<string[]>([]);
  const [siteDraft, setSiteDraft] = useState<UserSiteAccessGrant[]>([]);
  const [siteToAdd, setSiteToAdd] = useState<string>('');
  const [siteLevelToAdd, setSiteLevelToAdd] = useState<SiteAccessLevel>('VIEW');
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({
    email: '',
    role: 'VIEWER' as UserRole,
    message: '',
    siteIds: [] as string[],
    features: [] as string[],
  });

  const usersQuery = useQuery({
    queryKey: ['admin-users', includeInactive, search],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('includeInactive', includeInactive ? 'true' : 'false');
      if (search.trim()) {
        params.set('search', search.trim());
      }
      return apiClient.get<AuthUser[]>(`/users?${params.toString()}`);
    },
  });

  const featureFlagsQuery = useQuery({
    queryKey: ['user-feature-flags'],
    queryFn: () => apiClient.get<FeatureFlagDefinition[]>('/users/features'),
  });

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });

  const detailQuery = useQuery({
    queryKey: ['admin-user-detail', managedUser?.id],
    queryFn: () => apiClient.get<UserDetail>(`/users/${managedUser?.id}`),
    enabled: !!managedUser,
  });

  const auditQuery = useQuery({
    queryKey: ['admin-user-audit', managedUser?.id],
    queryFn: () => apiClient.get<AuditEntry[]>(`/users/${managedUser?.id}/audit?take=50`),
    enabled: !!managedUser,
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateUserFormState) => apiClient.post<AuthUser>('/users', payload),
    onSuccess: () => {
      setCreateForm({
        email: '',
        password: '',
        role: 'OPERATOR',
        firstName: '',
        lastName: '',
        timeFormat: '24h',
      });
      setCreateMessage('User created successfully.');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Unable to create user. Please try again.';
      setCreateMessage(message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; body: Partial<UpdateUserDtoPayload> }) =>
      apiClient.patch<AuthUser>(`/users/${payload.id}`, payload.body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['admin-user-detail', data.id] });
      queryClient.invalidateQueries({ queryKey: ['users', 'me'] });
      if (authUser?.id === data.id) {
        setAuthUser(data);
      }
      if (managedUser && managedUser.id === data.id) {
        setManagedUser(data);
        setManageForm({
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
          phone: data.phone ?? '',
          jobTitle: data.jobTitle ?? '',
          timeFormat: (data.preferences.timeFormat as TimeFormatPreference) ?? '24h',
          password: '',
        });
        setManageMessage('Changes saved.');
      }
    },
    onError: (error: unknown) => {
      if (managedUser) {
        const message =
          error instanceof Error ? error.message : 'Unable to update user. Please try again.';
        setManageMessage(message);
      }
    },
  });

  const disableMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete<AuthUser>(`/users/${id}`),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['admin-user-detail', data.id] });
      queryClient.invalidateQueries({ queryKey: ['users', 'me'] });
      if (authUser?.id === data.id) {
        setAuthUser(data);
      }
      if (managedUser && managedUser.id === data.id) {
        setManagedUser(data);
        setManageForm({
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
          phone: data.phone ?? '',
          jobTitle: data.jobTitle ?? '',
          timeFormat: (data.preferences.timeFormat as TimeFormatPreference) ?? '24h',
          password: '',
        });
        setManageMessage(data.isActive ? 'User reactivated.' : 'User deactivated.');
      }
    },
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: (payload: { id: string; features: string[] }) =>
      apiClient.patch<UserDetail>(`/users/${payload.id}/permissions`, {
        features: payload.features,
      }),
    onSuccess: (detail) => {
      queryClient.invalidateQueries({ queryKey: ['admin-user-detail', detail.id] });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setFeatureSelection(detail.permissions ?? []);
      setPermissionsMessage('Permissions updated.');
      if (authUser?.id === detail.id) {
        const { pendingInvitations: _pendingInvitations, ...rest } = detail;
        setAuthUser(rest);
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unable to update permissions.';
      setPermissionsMessage(message);
    },
  });

  const updateSiteAccessMutation = useMutation({
    mutationFn: (payload: { id: string; siteAccess: UserSiteAccessGrant[] }) =>
      apiClient.patch<UserDetail>(`/users/${payload.id}/sites`, {
        siteAccess: payload.siteAccess.map((assignment) => ({
          siteId: assignment.siteId,
          level: assignment.level,
        })),
      }),
    onSuccess: (detail) => {
      queryClient.invalidateQueries({ queryKey: ['admin-user-detail', detail.id] });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setSiteDraft(detail.siteAccess ?? []);
      setSiteMessage('Site access updated.');
      if (authUser?.id === detail.id) {
        const { pendingInvitations: _pendingInvitations, ...rest } = detail;
        setAuthUser(rest);
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unable to update site access.';
      setSiteMessage(message);
    },
  });

  const sendResetMutation = useMutation({
    mutationFn: (id: string) => apiClient.post<void>(`/users/${id}/password-reset`),
    onSuccess: () => {
      setResetMessage('Password reset email sent.');
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unable to send reset email.';
      setResetMessage(message);
    },
  });

  const createInvitationMutation = useMutation({
    mutationFn: (payload: {
      email: string;
      role: UserRole;
      message?: string;
      siteIds: string[];
      permissions: string[];
    }) => apiClient.post('/users/invitations', payload),
    onSuccess: () => {
      setInviteMessage('Invitation sent.');
      setInviteForm((prev) => ({
        ...prev,
        email: '',
        message: '',
        siteIds: [],
      }));
      if (managedUser) {
        queryClient.invalidateQueries({ queryKey: ['admin-user-detail', managedUser.id] });
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unable to send invitation.';
      setInviteMessage(message);
    },
  });

  useEffect(() => {
    if (detailQuery.data) {
      const detail = detailQuery.data;
      setManageForm({
        firstName: detail.firstName ?? '',
        lastName: detail.lastName ?? '',
        phone: detail.phone ?? '',
        jobTitle: detail.jobTitle ?? '',
        timeFormat: (detail.preferences.timeFormat as TimeFormatPreference) ?? '24h',
        password: '',
      });
      setFeatureSelection(detail.permissions ?? []);
      setSiteDraft(detail.siteAccess ?? []);
    } else if (!managedUser) {
      setManageMessage(null);
      setPermissionsMessage(null);
      setSiteMessage(null);
      setResetMessage(null);
    }
  }, [detailQuery.data, managedUser]);

  const availableSites = useMemo(() => {
    const sites = sitesQuery.data ?? [];
    return sites.filter((site) => !siteDraft.some((assignment) => assignment.siteId === site.id));
  }, [sitesQuery.data, siteDraft]);

  useEffect(() => {
    if (availableSites.length > 0 && !availableSites.some((site) => site.id === siteToAdd)) {
      setSiteToAdd(availableSites[0].id);
    }
  }, [availableSites, siteToAdd]);

  useEffect(() => {
    const flags = featureFlagsQuery.data ?? [];
    if (flags.length > 0 && inviteForm.features.length === 0) {
      const defaults = flags
        .filter((flag) => flag.defaultForRoles.includes(inviteForm.role))
        .map((flag) => flag.key);
      setInviteForm((prev) => ({ ...prev, features: defaults }));
    }
  }, [featureFlagsQuery.data, inviteForm.features.length, inviteForm.role]);

  const rows = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const featureFlags = featureFlagsQuery.data ?? [];
  const sites = sitesQuery.data ?? [];
  const detail = detailQuery.data;
  const auditEntries = auditQuery.data ?? [];

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    setCreateMessage(null);
    createMutation.mutate(createForm);
  };

  const handleRoleChange = (id: string, role: UserRole) => {
    updateMutation.mutate({ id, body: { role } });
  };

  const handleToggleActive = (user: AuthUser) => {
    if (!user.isActive) {
      updateMutation.mutate({ id: user.id, body: { isActive: true } });
      return;
    }
    disableMutation.mutate(user.id);
  };

  const toggleFeature = (feature: string) => {
    setFeatureSelection((current) =>
      current.includes(feature)
        ? current.filter((value) => value !== feature)
        : [...current, feature],
    );
  };

  const handleAddSite = () => {
    if (!siteToAdd) {
      return;
    }
    const site = sites.find((candidate) => candidate.id === siteToAdd);
    if (!site) {
      return;
    }
    setSiteDraft((prev) => [
      ...prev,
      {
        siteId: site.id,
        level: siteLevelToAdd,
        siteName: site.name,
      },
    ]);
    setSiteToAdd('');
  };

  const handleRemoveSite = (siteId: string) => {
    setSiteDraft((prev) => prev.filter((assignment) => assignment.siteId !== siteId));
  };

  const formatDateTime = (value: string) => {
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return value;
    }
  };

  return (
    <section className="panel admin-panel">
      <header className="panel__header panel__header--stacked">
        <div>
          <h2 className="panel__title">User Management</h2>
          <p className="panel__subtitle">Create accounts, adjust roles, and control access.</p>
        </div>
        <div className="toolbar">
          <input
            className="control-input"
            placeholder="Search users"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="control-checkbox">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            <span>Include inactive</span>
          </label>
        </div>
      </header>

      <form className="form-grid" onSubmit={handleCreate} autoComplete="off">
        <h3 className="section-heading">Create User</h3>
        <label>
          <span>Email</span>
          <input
            className="control-input"
            type="email"
            autoComplete="off"
            value={createForm.email}
            onChange={(event) => setCreateForm((prev) => ({ ...prev, email: event.target.value }))}
            required
          />
        </label>
        <label>
          <span>Temporary Password</span>
          <input
            className="control-input"
            type="password"
            autoComplete="new-password"
            value={createForm.password}
            onChange={(event) =>
              setCreateForm((prev) => ({ ...prev, password: event.target.value }))
            }
            required
          />
        </label>
        <label>
          <span>Role</span>
          <select
            className="control-input"
            value={createForm.role}
            onChange={(event) =>
              setCreateForm((prev) => ({ ...prev, role: event.target.value as UserRole }))
            }
          >
            <option value="OPERATOR">Operator</option>
            <option value="ANALYST">Analyst</option>
            <option value="VIEWER">Viewer</option>
            <option value="ADMIN">Admin</option>
          </select>
        </label>
        <label>
          <span>First Name</span>
          <input
            className="control-input"
            value={createForm.firstName}
            onChange={(event) =>
              setCreateForm((prev) => ({ ...prev, firstName: event.target.value }))
            }
          />
        </label>
        <label>
          <span>Last Name</span>
          <input
            className="control-input"
            value={createForm.lastName}
            onChange={(event) =>
              setCreateForm((prev) => ({ ...prev, lastName: event.target.value }))
            }
          />
        </label>
        <label>
          <span>Time Format</span>
          <select
            className="control-input"
            value={createForm.timeFormat}
            onChange={(event) =>
              setCreateForm((prev) => ({
                ...prev,
                timeFormat: event.target.value as TimeFormatPreference,
              }))
            }
          >
            <option value="24h">24-hour</option>
            <option value="12h">12-hour</option>
          </select>
        </label>
        <div className="form-row form-row--actions">
          <button type="submit" className="submit-button" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating...' : 'Create User'}
          </button>
          {createMessage ? <span className="form-feedback">{createMessage}</span> : null}
        </div>
      </form>

      <div className="section-divider" />

      {usersQuery.isLoading ? (
        <div className="empty-state">
          <div>Loading users...</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <div>No users found.</div>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Time Format</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => (
                <tr key={user.id} className={!user.isActive ? 'is-inactive' : undefined}>
                  <td>{user.email}</td>
                  <td>{[user.firstName, user.lastName].filter(Boolean).join(' ') || '--'}</td>
                  <td>
                    <select
                      className="table-select"
                      value={user.role}
                      onChange={(event) =>
                        handleRoleChange(user.id, event.target.value as UserRole)
                      }
                      disabled={updateMutation.isPending || user.id === authUser?.id}
                    >
                      <option value="ADMIN">Admin</option>
                      <option value="OPERATOR">Operator</option>
                      <option value="ANALYST">Analyst</option>
                      <option value="VIEWER">Viewer</option>
                    </select>
                  </td>
                  <td>{user.isActive ? 'Active' : 'Inactive'}</td>
                  <td>
                    <select
                      className="table-select"
                      value={user.preferences.timeFormat}
                      onChange={(event) =>
                        updateMutation.mutate({
                          id: user.id,
                          body: { timeFormat: event.target.value as TimeFormatPreference },
                        })
                      }
                      disabled={updateMutation.isPending}
                    >
                      <option value="24h">24-hour</option>
                      <option value="12h">12-hour</option>
                    </select>
                  </td>
                  <td>
                    <div className="button-group">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => {
                          setManagedUser(user);
                          setManageMessage(null);
                          setPermissionsMessage(null);
                          setSiteMessage(null);
                          setResetMessage(null);
                        }}
                      >
                        Manage
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => handleToggleActive(user)}
                        disabled={disableMutation.isPending}
                      >
                        {user.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {managedUser ? (
        <div className="admin-user-manage">
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              setManageMessage(null);
              const body: Partial<UpdateUserDtoPayload> = {
                firstName: manageForm.firstName,
                lastName: manageForm.lastName,
                phone: manageForm.phone,
                jobTitle: manageForm.jobTitle,
                timeFormat: manageForm.timeFormat,
              };
              if (manageForm.password.trim()) {
                body.password = manageForm.password.trim();
              }
              updateMutation.mutate({
                id: managedUser.id,
                body,
              });
            }}
          >
            <h3 className="section-heading">Manage {managedUser.email}</h3>
            <label>
              <span>First Name</span>
              <input
                className="control-input"
                value={manageForm.firstName}
                onChange={(event) =>
                  setManageForm((prev) => ({ ...prev, firstName: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Last Name</span>
              <input
                className="control-input"
                value={manageForm.lastName}
                onChange={(event) =>
                  setManageForm((prev) => ({ ...prev, lastName: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Phone</span>
              <input
                className="control-input"
                value={manageForm.phone}
                onChange={(event) =>
                  setManageForm((prev) => ({ ...prev, phone: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Job Title</span>
              <input
                className="control-input"
                value={manageForm.jobTitle}
                onChange={(event) =>
                  setManageForm((prev) => ({ ...prev, jobTitle: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Time Format</span>
              <select
                className="control-input"
                value={manageForm.timeFormat}
                onChange={(event) =>
                  setManageForm((prev) => ({
                    ...prev,
                    timeFormat: event.target.value as TimeFormatPreference,
                  }))
                }
              >
                <option value="24h">24-hour</option>
                <option value="12h">12-hour</option>
              </select>
            </label>
            <label>
              <span>Set New Password</span>
              <input
                className="control-input"
                type="password"
                value={manageForm.password}
                placeholder="Leave blank to keep current password"
                onChange={(event) =>
                  setManageForm((prev) => ({ ...prev, password: event.target.value }))
                }
              />
            </label>
            <div className="form-row form-row--actions">
              <div className="button-group">
                <button type="submit" className="submit-button" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  className="control-chip"
                  onClick={() => {
                    setManagedUser(null);
                    setManageMessage(null);
                    setPermissionsMessage(null);
                    setSiteMessage(null);
                    setResetMessage(null);
                    setManageForm({
                      firstName: '',
                      lastName: '',
                      phone: '',
                      jobTitle: '',
                      timeFormat: '24h',
                      password: '',
                    });
                    setFeatureSelection([]);
                    setSiteDraft([]);
                  }}
                >
                  Close
                </button>
              </div>
              {manageMessage ? <span className="form-feedback">{manageMessage}</span> : null}
            </div>
          </form>

          <div className="admin-section">
            <div className="admin-section__header">
              <h4>Feature Permissions</h4>
              <button
                type="button"
                className="submit-button"
                disabled={updatePermissionsMutation.isPending}
                onClick={() => {
                  if (managedUser) {
                    setPermissionsMessage(null);
                    updatePermissionsMutation.mutate({
                      id: managedUser.id,
                      features: featureSelection,
                    });
                  }
                }}
              >
                {updatePermissionsMutation.isPending ? 'Saving…' : 'Save Permissions'}
              </button>
            </div>
            {featureFlagsQuery.isLoading ? (
              <div>Loading feature definitions…</div>
            ) : featureFlags.length === 0 ? (
              <div>No feature flags configured.</div>
            ) : (
              <div className="feature-grid">
                {featureFlags.map((flag) => {
                  const checkboxId = `feature-${flag.key}`;
                  return (
                    <div key={flag.key} className="feature-flag">
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={featureSelection.includes(flag.key)}
                        onChange={() => toggleFeature(flag.key)}
                      />
                      <label htmlFor={checkboxId}>
                        <div className="feature-flag__label">{flag.label}</div>
                        <div className="feature-flag__description">{flag.description}</div>
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
            {permissionsMessage ? <div className="form-feedback">{permissionsMessage}</div> : null}
          </div>

          <div className="admin-section">
            <div className="admin-section__header">
              <h4>Site Access</h4>
              <button
                type="button"
                className="submit-button"
                disabled={updateSiteAccessMutation.isPending}
                onClick={() => {
                  if (managedUser) {
                    setSiteMessage(null);
                    updateSiteAccessMutation.mutate({ id: managedUser.id, siteAccess: siteDraft });
                  }
                }}
              >
                {updateSiteAccessMutation.isPending ? 'Saving…' : 'Save Site Access'}
              </button>
            </div>
            {siteDraft.length === 0 ? (
              <div>No site assignments.</div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th>Level</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {siteDraft.map((assignment) => (
                      <tr key={assignment.siteId}>
                        <td>{assignment.siteName ?? assignment.siteId}</td>
                        <td>
                          <select
                            className="table-select"
                            value={assignment.level}
                            onChange={(event) => {
                              const nextLevel = event.target.value as SiteAccessLevel;
                              setSiteDraft((prev) =>
                                prev.map((entry) =>
                                  entry.siteId === assignment.siteId
                                    ? { ...entry, level: nextLevel }
                                    : entry,
                                ),
                              );
                            }}
                          >
                            <option value="VIEW">View</option>
                            <option value="MANAGE">Manage</option>
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="control-chip"
                            onClick={() => handleRemoveSite(assignment.siteId)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="site-add-row">
              <select
                className="control-input"
                value={siteToAdd}
                onChange={(event) => setSiteToAdd(event.target.value)}
              >
                <option value="" disabled>
                  Select site
                </option>
                {availableSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
              <select
                className="control-input"
                value={siteLevelToAdd}
                onChange={(event) => setSiteLevelToAdd(event.target.value as SiteAccessLevel)}
              >
                <option value="VIEW">View</option>
                <option value="MANAGE">Manage</option>
              </select>
              <button type="button" className="control-chip" onClick={handleAddSite}>
                Add
              </button>
            </div>
            {siteMessage ? <div className="form-feedback">{siteMessage}</div> : null}
          </div>

          <div className="admin-section">
            <div className="admin-section__header">
              <h4>Security Actions</h4>
              <button
                type="button"
                className="control-chip"
                onClick={() => {
                  if (managedUser) {
                    setResetMessage(null);
                    sendResetMutation.mutate(managedUser.id);
                  }
                }}
                disabled={sendResetMutation.isPending}
              >
                {sendResetMutation.isPending ? 'Sending…' : 'Send Password Reset'}
              </button>
            </div>
            {resetMessage ? <div className="form-feedback">{resetMessage}</div> : null}
          </div>

          <div className="admin-section">
            <h4>Pending Invitations</h4>
            {detail && detail.pendingInvitations.length > 0 ? (
              <ul className="invitation-list">
                {detail.pendingInvitations.map((invite) => (
                  <li key={invite.id}>
                    <span>{invite.email}</span>
                    <span>Expires: {formatDateTime(invite.expiresAt)}</span>
                    <span className="token-preview">Token: {invite.token}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div>No pending invitations for this address.</div>
            )}
          </div>

          <div className="admin-section">
            <h4>Recent Audit</h4>
            {auditQuery.isLoading ? (
              <div>Loading audit history…</div>
            ) : auditEntries.length === 0 ? (
              <div>No recent audit entries.</div>
            ) : (
              <ul className="audit-list">
                {auditEntries.map((entry) => (
                  <li key={entry.id}>
                    <span className="audit-timestamp">{formatDateTime(entry.createdAt)}</span>
                    <span className="audit-action">{entry.action}</span>
                    <span className="audit-entity">{entry.entity}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      <div className="admin-section">
        <h3 className="section-heading">Send Invitation</h3>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            setInviteMessage(null);
            createInvitationMutation.mutate({
              email: inviteForm.email,
              role: inviteForm.role,
              message: inviteForm.message ? inviteForm.message : undefined,
              siteIds: inviteForm.siteIds,
              permissions: inviteForm.features,
            });
          }}
        >
          <label>
            <span>Email</span>
            <input
              className="control-input"
              type="email"
              value={inviteForm.email}
              onChange={(event) =>
                setInviteForm((prev) => ({ ...prev, email: event.target.value }))
              }
              required
            />
          </label>
          <label>
            <span>Role</span>
            <select
              className="control-input"
              value={inviteForm.role}
              onChange={(event) => {
                const nextRole = event.target.value as UserRole;
                const defaults = (featureFlagsQuery.data ?? [])
                  .filter((flag) => flag.defaultForRoles.includes(nextRole))
                  .map((flag) => flag.key);
                setInviteForm((prev) => ({
                  ...prev,
                  role: nextRole,
                  features: defaults,
                }));
              }}
            >
              <option value="VIEWER">Viewer</option>
              <option value="ANALYST">Analyst</option>
              <option value="OPERATOR">Operator</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
          <label>
            <span>Message</span>
            <textarea
              className="control-input"
              value={inviteForm.message}
              onChange={(event) =>
                setInviteForm((prev) => ({ ...prev, message: event.target.value }))
              }
            />
          </label>
          <label>
            <span>Site Access</span>
            <select
              multiple
              className="control-input"
              value={inviteForm.siteIds}
              onChange={(event) => {
                const values = Array.from(event.target.selectedOptions).map(
                  (option) => option.value,
                );
                setInviteForm((prev) => ({ ...prev, siteIds: values }));
              }}
            >
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
          <div className="feature-grid">
            {featureFlags.map((flag) => {
              const inviteCheckboxId = `invite-feature-${flag.key}`;
              return (
                <div key={flag.key} className="feature-flag">
                  <input
                    id={inviteCheckboxId}
                    type="checkbox"
                    checked={inviteForm.features.includes(flag.key)}
                    onChange={() =>
                      setInviteForm((prev) => ({
                        ...prev,
                        features: prev.features.includes(flag.key)
                          ? prev.features.filter((value) => value !== flag.key)
                          : [...prev.features, flag.key],
                      }))
                    }
                  />
                  <label htmlFor={inviteCheckboxId}>
                    <div className="feature-flag__label">{flag.label}</div>
                    <div className="feature-flag__description">{flag.description}</div>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="form-row form-row--actions">
            <button
              type="submit"
              className="submit-button"
              disabled={createInvitationMutation.isPending}
            >
              {createInvitationMutation.isPending ? 'Sending…' : 'Send Invitation'}
            </button>
            {inviteMessage ? <span className="form-feedback">{inviteMessage}</span> : null}
          </div>
        </form>
      </div>
    </section>
  );
}

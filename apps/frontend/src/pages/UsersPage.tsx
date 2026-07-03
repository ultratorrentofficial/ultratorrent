import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Shield, Trash2, Users } from 'lucide-react';
import {
  ApiError,
  api,
  type CreateUserInput,
  type Role,
  type UpdateUserInput,
  type User,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

export function UsersPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: api.users.list,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const remove = async (user: User) => {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await api.users.remove(user.id);
      toast.success('User deleted', user.username);
      invalidate();
    } catch (err) {
      toast.error('Could not delete user', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            Manage accounts and the roles that grant them permissions.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading users…" />
      ) : isError ? (
        <ErrorState message="Could not load users." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No users"
              description="Add accounts and assign them roles to control access."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> Add your first user
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((user) => (
            <Card key={user.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{user.displayName || user.username}</p>
                    <Badge variant={user.isActive ? 'success' : 'secondary'} dot>
                      {user.isActive ? 'Active' : 'Disabled'}
                    </Badge>
                    {user.isSystem && <Badge variant="warning">system</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>@{user.username}</span>
                    <span>{user.email}</span>
                    <span>last login {formatRelativeTime(user.lastLoginAt)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {user.roles.length === 0 ? (
                      <span className="text-xs text-muted-foreground">no roles</span>
                    ) : (
                      user.roles.map((r) => (
                        <Badge key={r} variant="info">
                          <Shield className="h-3 w-3" /> {r.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" aria-label="Edit user" onClick={() => setEditing(user)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete user"
                    disabled={user.isSystem}
                    title={user.isSystem ? 'System users cannot be deleted' : undefined}
                    onClick={() => remove(user)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}
      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function RolePicker({
  roles,
  selected,
  onToggle,
}: {
  roles: Role[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (roles.length === 0) {
    return <p className="text-xs text-muted-foreground">No roles available.</p>;
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      {roles.map((role) => (
        <label key={role.id} className="flex cursor-pointer items-start gap-2.5">
          <Checkbox
            checked={selected.includes(role.name)}
            onCheckedChange={() => onToggle(role.name)}
            aria-label={role.name}
            className="mt-0.5"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">{role.name.replace(/_/g, ' ').toLowerCase()}</p>
            {role.description && (
              <p className="text-xs text-muted-foreground">{role.description}</p>
            )}
          </div>
        </label>
      ))}
    </div>
  );
}

function useRoles() {
  return useQuery({ queryKey: ['users', 'roles'], queryFn: api.users.roles });
}

function CreateUserDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data: roles } = useRoles();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const toggleRole = (name: string) =>
    setRoleNames((prev) => (prev.includes(name) ? prev.filter((r) => r !== name) : [...prev, name]));

  const submit = async () => {
    setSaving(true);
    try {
      const body: CreateUserInput = {
        username: username.trim(),
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        password,
        roleNames,
      };
      await api.users.create(body);
      toast.success('User created', body.username);
      onSaved();
    } catch (err) {
      toast.error('Could not create user', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const valid = username.trim() && email.trim() && password.length >= 10;

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Add user</DialogTitle>
        <DialogDescription>Create an account and assign roles.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="u-username">Username</Label>
            <Input id="u-username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="u-display">Display name</Label>
            <Input id="u-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="u-email">Email</Label>
          <Input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="u-password">Password</Label>
          <Input
            id="u-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="at least 10 characters"
          />
          {password.length > 0 && password.length < 10 && (
            <p className="mt-1 text-xs text-destructive">Password must be at least 10 characters.</p>
          )}
        </div>
        <div>
          <Label>Roles</Label>
          <RolePicker roles={roles ?? []} selected={roleNames} onToggle={toggleRole} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving} disabled={!valid}>
          Create user
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { data: roles } = useRoles();
  const [email, setEmail] = useState(user.email);
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [isActive, setIsActive] = useState(user.isActive);
  const [roleNames, setRoleNames] = useState<string[]>(user.roles);
  const [saving, setSaving] = useState(false);

  const toggleRole = (name: string) =>
    setRoleNames((prev) => (prev.includes(name) ? prev.filter((r) => r !== name) : [...prev, name]));

  const submit = async () => {
    setSaving(true);
    try {
      const body: UpdateUserInput = {
        email: email.trim(),
        displayName: displayName.trim(),
        isActive,
        roleNames,
      };
      await api.users.update(user.id, body);
      toast.success('User updated', user.username);
      onSaved();
    } catch (err) {
      toast.error('Could not update user', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit {user.username}</DialogTitle>
        <DialogDescription>Username and password cannot be changed here.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="eu-email">Email</Label>
          <Input id="eu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="eu-display">Display name</Label>
          <Input id="eu-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <Label htmlFor="eu-active">Active</Label>
          <Switch id="eu-active" checked={isActive} onCheckedChange={setIsActive} />
        </div>
        <div>
          <Label>Roles</Label>
          <RolePicker roles={roles ?? []} selected={roleNames} onToggle={toggleRole} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving} disabled={!email.trim()}>
          Save changes
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

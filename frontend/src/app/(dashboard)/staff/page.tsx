'use client';

import { useState, useEffect } from 'react';
import axios from 'axios';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, X, Edit, LayoutGrid, RotateCcw, Eye, EyeOff } from 'lucide-react';
import type { Staff } from '@/lib/types';
import { useTranslations, type AppConfig } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { PermissionMatrix } from '@/components/settings/PermissionMatrix';
import { ROLE_ACCESS, ROLE_KEYS, hasRole } from '@shared/role-permissions';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';
import { invalidEmailCharacters, isValidEmailInput, sanitizeEmailInput } from '@/lib/email-input';

const VALID_ROLES = ROLE_KEYS;

type TableOption = { id: string; number: string };

type StaffKey = keyof AppConfig['Messages']['staff'];

const roleColors: Record<string, string> = {
  owner: 'bg-red-100 text-red-800',
  manager: 'bg-purple-100 text-purple-800',
  cashier: 'bg-blue-100 text-blue-800',
  server: 'bg-green-100 text-green-800',
  chef: 'bg-orange-100 text-orange-800',
};

function roleLabel(role: string, t: (key: StaffKey) => string): string {
  const key = ROLE_LABEL_KEYS[role];
  return key ? t(key) : role;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const apiError = error.response?.data?.error;
    if (typeof apiError === 'string' && apiError.trim()) return apiError;
  }
  return fallback;
}

export default function StaffPage() {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const tAuth = useTranslations('auth');
  const tSetup = useTranslations('setup');
  const { currentTenant } = useAuthStore();
  const canViewPermissionMatrix = hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null);
  const [showResetPw, setShowResetPw] = useState(false);
  const [resetPwStaff, setResetPwStaff] = useState<Staff | null>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    role: 'server',
    pin: '',
  });
  const [tablesStaff, setTablesStaff] = useState<Staff | null>(null);
  const [allTables, setAllTables] = useState<TableOption[]>([]);
  const [assignedTableIds, setAssignedTableIds] = useState<string[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesSaving, setTablesSaving] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);

  const fetchStaff = async () => {
    try {
      const { data } = await api.get('/staff');
      setStaff(data.staff || []);
    } catch {
      toast.error(t('failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/staff')
      .then(({ data }) => setStaff(data.staff || []))
      .catch(() => toast.error(t('failedToLoad')))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => {
    setEditingStaff(null);
    setForm({ name: '', email: '', password: '', confirmPassword: '', role: 'server', pin: '' });
    setShowPassword(false);
    setShowPin(false);
    setShowForm(true);
  };

  const openEdit = (s: Staff) => {
    setEditingStaff(s);
    setForm({ name: s.name, email: s.email || '', password: '', confirmPassword: '', role: s.role, pin: '' });
    setShowPassword(false);
    setShowPin(false);
    setShowForm(true);
  };

  const openResetPw = (s: Staff) => {
    setResetPwStaff(s);
    setNewPassword('');
    setConfirmNewPassword('');
    setShowResetPassword(false);
    setShowResetPw(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password && form.password !== form.confirmPassword) {
      toast.error(tSetup('passwordsMismatch'));
      return;
    }
    // Checked here rather than left to the browser: its own refusal names a
    // character the field does not visibly contain, which reads as a dead form.
    const email = sanitizeEmailInput(form.email).trim();
    if (!isValidEmailInput(email)) {
      const bad = invalidEmailCharacters(email);
      toast.error(bad ? t('emailBadCharacters', { characters: bad }) : tSetup('errorInvalidEmail'));
      return;
    }
    try {
      if (editingStaff) {
        await api.put(`/staff/${editingStaff.id}`, {
          name: form.name,
          email,
          role: form.role,
          ...(form.password ? { password: form.password } : {}),
          ...(form.pin ? { pin: form.pin } : {}),
        });
        toast.success(t('updatedToast'));
      } else {
        await api.post('/staff', {
          name: form.name,
          email,
          password: form.password,
          role: form.role,
          ...(form.pin ? { pin: form.pin } : {}),
        });
        toast.success(t('addedToast'));
      }
      closeForm();
      fetchStaff();
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('failedToSave')));
    }
  };

  const handleResetPassword = async () => {
    if (!resetPwStaff || !newPassword) return;
    if (newPassword !== confirmNewPassword) {
      toast.error(tSetup('passwordsMismatch'));
      return;
    }
    try {
      await api.put(`/staff/${resetPwStaff.id}`, { password: newPassword });
      toast.success(t('resetPasswordToast'));
      closeResetPassword();
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('failedToReset')));
    }
  };

  const openTables = async (s: Staff) => {
    setTablesStaff(s);
    setTablesLoading(true);
    setAssignedTableIds([]);
    try {
      const [tablesRes, assignedRes] = await Promise.all([
        api.get('/tables', { params: { active: 'true' } }),
        api.get(`/staff/${s.id}/tables`),
      ]);
      setAllTables(tablesRes.data.tables || []);
      setAssignedTableIds(assignedRes.data.table_ids || []);
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('failedToLoad')));
      setTablesStaff(null);
    } finally {
      setTablesLoading(false);
    }
  };

  const toggleAssignedTable = (tableId: string) => {
    setAssignedTableIds((ids) => ids.includes(tableId) ? ids.filter((id) => id !== tableId) : [...ids, tableId]);
  };

  const saveAssignedTables = async () => {
    if (!tablesStaff) return;
    setTablesSaving(true);
    try {
      await api.put(`/staff/${tablesStaff.id}/tables`, { table_ids: assignedTableIds });
      toast.success(t('tablesSavedToast'));
      setTablesStaff(null);
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('failedToSave')));
    } finally {
      setTablesSaving(false);
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setShowPassword(false);
    setShowPin(false);
  };

  const closeResetPassword = () => {
    setShowResetPw(false);
    setShowResetPassword(false);
  };

  const toggleActive = async (s: Staff) => {
    try {
      await api.post(`/staff/${s.id}/${s.is_active ? 'deactivate' : 'reactivate'}`);
      fetchStaff();
    } catch {
      toast.error(t('failedToUpdate'));
    }
  };

  const editingLastActiveOwner = Boolean(editingStaff?.is_active)
    && editingStaff?.role === 'owner'
    && staff.filter((s) => s.role === 'owner' && Boolean(s.is_active)).length === 1;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <Button onClick={openAdd}><Plus size={16} className="me-1" /> {t('addButton')}</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {staff.map((s) => (
          <div key={s.id} className={`bg-card rounded-xl p-5 border ${s.is_active ? 'border-border' : 'border-border opacity-60'}`}>
            <div className="flex justify-between items-start mb-3">
              <div>
                <p className="font-bold text-foreground">{s.name}</p>
                <p className="text-xs text-muted-foreground">{s.email || '—'}</p>
                {Boolean(s.has_pin) && (
                  <p className="text-xs text-green-600 mt-1">{t('pinSet')}</p>
                )}
              </div>
              <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${roleColors[s.role] || 'bg-muted text-foreground'}`}>
                {roleLabel(s.role, t)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="outline" size="sm" onClick={() => openEdit(s)}>
                <Edit size={14} className="me-1" /> {tCommon('edit')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openResetPw(s)}>
                <RotateCcw size={14} className="me-1" /> {t('resetPwButton')}
              </Button>
              {s.role === 'server' && (
                <Button variant="outline" size="sm" onClick={() => openTables(s)}>
                  <LayoutGrid size={14} className="me-1" /> {t('tablesButton')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleActive(s)}
                className={s.is_active ? 'text-red-500 hover:text-red-700 hover:bg-red-50' : 'text-green-500 hover:text-green-700 hover:bg-green-50'}
              >
                {s.is_active ? t('deactivate') : t('reactivate')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {staff.length === 0 && <p className="text-center text-muted-foreground py-12">{t('empty')}</p>}

      {canViewPermissionMatrix && <PermissionMatrix />}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingStaff ? t('modalTitleEdit') : t('modalTitleAdd')}</h2>
              <button type="button" onClick={closeForm}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSave} className="space-y-4" noValidate>
              <input
                type="text" placeholder={t('namePlaceholder')} value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required
              />
              <input
                type="email" placeholder={tAuth('email')} value={form.email}
                onChange={(e) => setForm({ ...form, email: sanitizeEmailInput(e.target.value) })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                autoComplete="email"
                dir="ltr"
                required
              />
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'} placeholder={editingStaff ? t('newPasswordPlaceholder') : t('passwordPlaceholder')}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full px-3 py-2 pe-10 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  required={!editingStaff}
                />
                <button type="button" aria-label="Toggle password visibility" title="Toggle password visibility" onClick={() => setShowPassword(!showPassword)} className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'} placeholder={tAuth('confirmPassword')}
                value={form.confirmPassword}
                onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                required={!editingStaff || Boolean(form.password)}
              />
              <select
                value={form.role} onChange={(e) => {
                  const role = e.target.value;
                  setForm({ ...form, role, pin: hasRole(role, ROLE_ACCESS.ownerManager) ? form.pin : '' });
                }}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              >
                {VALID_ROLES.map((r) => (
                  <option key={r} value={r} disabled={editingLastActiveOwner && r !== 'owner'}>{roleLabel(r, t)}</option>
                ))}
              </select>
              {hasRole(form.role, ROLE_ACCESS.ownerManager) && (
                <div>
                  <div className="relative">
                    <input
                      type={showPin ? 'text' : 'password'} placeholder={editingStaff ? t('pinPlaceholderEdit') : t('pinPlaceholderAdd')}
                      value={form.pin}
                      onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                      className="w-full px-3 py-2 pe-10 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                      maxLength={6}
                      pattern="[0-9]*"
                      inputMode="numeric"
                    />
                    <button type="button" aria-label="Toggle PIN visibility" title="Toggle PIN visibility" onClick={() => setShowPin(!showPin)} className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t('pinHint')}</p>
                </div>
              )}
              <Button type="submit" className="w-full">{editingStaff ? t('updateButton') : t('addButton')}</Button>
            </form>
          </div>
        </div>
      )}

      {tablesStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-card w-full max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 max-h-[85vh] flex flex-col">
            <div className="flex justify-between items-start gap-3 mb-2">
              <h2 className="text-lg font-bold">{t('tablesModalTitle', { name: tablesStaff.name })}</h2>
              <button type="button" onClick={() => setTablesStaff(null)} aria-label={tCommon('close')}>
                <X size={20} className="text-gray-400" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('tablesHint')}</p>

            {tablesLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>
            ) : allTables.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t('tablesEmpty')}</p>
            ) : (
              <div className="flex-1 overflow-y-auto -mx-1 px-1">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {allTables.map((table) => {
                    const checked = assignedTableIds.includes(table.id);
                    return (
                      <label
                        key={table.id}
                        className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${checked ? 'border-brand bg-brand/10 font-semibold' : 'border-border'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAssignedTable(table.id)}
                          className="rounded border-border text-brand focus:ring-brand"
                        />
                        <span className="truncate">{table.number}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setAssignedTableIds([])} disabled={tablesSaving || assignedTableIds.length === 0}>
                {t('tablesAllTables')}
              </Button>
              <Button onClick={saveAssignedTables} disabled={tablesLoading || tablesSaving}>
                {tablesSaving ? tCommon('saving') : tCommon('save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showResetPw && resetPwStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('resetPasswordTitle')}</h2>
              <button type="button" onClick={closeResetPassword}><X size={20} className="text-gray-400" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('resetPasswordBody', { name: resetPwStaff.name })}</p>
            <div className="space-y-4">
              <div className="relative">
                <input
                  type={showResetPassword ? 'text' : 'password'} placeholder={t('newPasswordPlaceholder')} value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 pe-10 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                />
                <button type="button" aria-label="Toggle password visibility" title="Toggle password visibility" onClick={() => setShowResetPassword(!showResetPassword)} className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showResetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <input
                type={showResetPassword ? 'text' : 'password'} placeholder={tAuth('confirmPassword')} value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
              <Button onClick={handleResetPassword} className="w-full">{t('resetPasswordTitle')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

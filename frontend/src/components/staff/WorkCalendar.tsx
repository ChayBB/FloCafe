'use client';

/**
 * Attendance for one month: a calendar of hours worked per day, and a roll-up
 * per person.
 *
 * Hours come from paired login/logout events on the Server App, so a shift that
 * has no logout yet is shown as open rather than counted. That distinction is
 * the point of the screen — a manager needs to tell "still on the floor" from
 * "forgot to sign out", and a total that quietly swallowed both would hide it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import toast from 'react-hot-toast';

type Shift = {
  user_id: string;
  user_name: string;
  date: string;
  start: string;
  end: string | null;
  minutes: number | null;
};

type StaffTotal = { user_id: string; user_name: string; minutes: number; shifts: number; open: number };

type Report = {
  year: string;
  month: string;
  shifts: Shift[];
  by_day: Record<string, number>;
  by_staff: StaffTotal[];
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-03-04 09:00:00` (UTC, SQLite's shape) rendered as a wall clock time. */
function clock(stamp: string): string {
  return stamp.slice(11, 16);
}

export function WorkCalendar() {
  const t = useTranslations('staff');
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [report, setReport] = useState<Report | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/staff/work-logs', { params: { year: String(year), month: pad(month) } })
      .then(({ data }) => { if (!cancelled) setReport(data); })
      .catch(() => { if (!cancelled) toast.error(t('workLogLoadFailed')); });
    return () => { cancelled = true; };
  }, [year, month, t]);

  const step = useCallback((delta: number) => {
    setSelectedDay(null);
    setReport(null);
    const next = new Date(year, month - 1 + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth() + 1);
  }, [year, month]);

  const formatHours = useCallback((minutes: number) => {
    if (minutes <= 0) return '—';
    return t('workLogHoursShort', { hours: Math.floor(minutes / 60), minutes: pad(minutes % 60) });
  }, [t]);

  // Monday-first grid, with blanks before the 1st so dates line up under the
  // weekday they actually fall on.
  const cells = useMemo(() => {
    const firstOfMonth = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const leading = (firstOfMonth.getDay() + 6) % 7;
    const out: (string | null)[] = Array.from({ length: leading }, () => null);
    for (let day = 1; day <= daysInMonth; day += 1) out.push(`${year}-${pad(month)}-${pad(day)}`);
    return out;
  }, [year, month]);

  const dayShifts = useMemo(
    () => (selectedDay && report ? report.shifts.filter((s) => s.date === selectedDay) : []),
    [selectedDay, report],
  );

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const weekdays = [t('workLogMon'), t('workLogTue'), t('workLogWed'), t('workLogThu'), t('workLogFri'), t('workLogSat'), t('workLogSun')];

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Clock size={18} /> {t('workLogTitle')}
        </h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => step(-1)} aria-label={t('workLogPrevMonth')} className="rounded-lg border border-border p-2 hover:bg-muted">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-36 text-center text-sm font-medium">{monthLabel}</span>
          <button type="button" onClick={() => step(1)} aria-label={t('workLogNextMonth')} className="rounded-lg border border-border p-2 hover:bg-muted">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {weekdays.map((day) => <div key={day} className="py-1">{day}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((date, index) => {
          if (!date) return <div key={`blank-${index}`} />;
          const minutes = report?.by_day[date] ?? 0;
          const isSelected = selectedDay === date;
          return (
            <button
              key={date}
              type="button"
              onClick={() => setSelectedDay(isSelected ? null : date)}
              className={`min-h-16 rounded-lg border p-1.5 text-start transition-colors ${
                isSelected ? 'border-brand bg-brand/10' : minutes > 0 ? 'border-border bg-muted/50 hover:bg-muted' : 'border-border/60 hover:bg-muted/40'
              }`}
            >
              <span className="block text-xs text-muted-foreground">{Number(date.slice(8))}</span>
              {minutes > 0 ? <span className="block text-xs font-medium text-foreground">{formatHours(minutes)}</span> : null}
            </button>
          );
        })}
      </div>

      {selectedDay ? (
        <div className="mt-4 rounded-lg border border-border p-3">
          <p className="mb-2 text-sm font-medium">{selectedDay}</p>
          {dayShifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('workLogNoShifts')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {dayShifts.map((shift) => (
                <li key={`${shift.user_id}-${shift.start}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{shift.user_name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {clock(shift.start)} – {shift.end ? clock(shift.end) : t('workLogStillOpen')}
                  </span>
                  <span className="w-20 shrink-0 text-end font-medium">
                    {shift.minutes === null ? '—' : formatHours(shift.minutes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="mt-4">
        <p className="mb-2 text-sm font-medium">{t('workLogMonthTotals')}</p>
        {!report ? (
          <p className="text-sm text-muted-foreground">{t('workLogLoading')}</p>
        ) : report.by_staff.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('workLogNoneThisMonth')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {report.by_staff.map((person) => (
              <li key={person.user_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{person.user_name}</span>
                {person.open > 0 ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                    {t('workLogOpenCount', { count: person.open })}
                  </span>
                ) : null}
                <span className="w-20 shrink-0 text-end font-medium">{formatHours(person.minutes)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import { CommandResponse } from '../api/types';
import { SchedulerEvent, SchedulerLogEntry, useSchedulerStore } from '../stores/scheduler-store';
import { useTemplateStore, CommandTemplate } from '../stores/template-store';

function beginningOfWeek(date: Date): Date {
  const clone = new Date(date);
  const day = clone.getDay();
  const diff = clone.getDate() - day + (day === 0 ? -6 : 1);
  clone.setDate(diff);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTimeDisplay(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const normalized = hours % 12 || 12;
  return `${normalized}:${minutes.toString().padStart(2, '0')} ${suffix}`;
}

function padTimeValue(value: number): string {
  return value.toString().padStart(2, '0');
}

function generateEventId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `sched-${globalThis.crypto.randomUUID()}`;
  }
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function SchedulerPage() {
  const templates = useTemplateStore((state) => state.templates);
  const {
    active,
    events,
    logs,
    addEvent,
    updateEvent,
    deleteEvent,
    copyDay,
    copyWeek,
    setActive,
    appendLog,
    markExecuted,
  } = useSchedulerStore();

  const [selectedWeekStart, setSelectedWeekStart] = useState(() => beginningOfWeek(new Date()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<SchedulerEvent | null>(null);
  const [formDate, setFormDate] = useState(formatDateKey(new Date()));
  const [formTime, setFormTime] = useState('08:00');
  const [formTemplateId, setFormTemplateId] = useState(() => templates[0]?.id ?? '');
  const [formNote, setFormNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const addLog = useCallback(
    (message: string, level: SchedulerLogEntry['level'] = 'info') => {
      appendLog({
        id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        message,
        level,
      });
    },
    [appendLog],
  );

  const mutation = useMutation({
    mutationFn: (body: { target: string; name: string; params: string[] }) =>
      apiClient.post<CommandResponse>('/commands/send', body),
  });

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }).map((_, index) => {
      const day = new Date(selectedWeekStart);
      day.setDate(selectedWeekStart.getDate() + index);
      return day;
    });
  }, [selectedWeekStart]);

  const eventsByDay = useMemo(() => {
    const mapping: Record<string, SchedulerEvent[]> = {};
    weekDays.forEach((day) => {
      mapping[formatDateKey(day)] = [];
    });
    events.forEach((event) => {
      if (mapping[event.date]) {
        mapping[event.date].push(event);
      }
    });
    Object.values(mapping).forEach((eventList) =>
      eventList.sort((a, b) => a.time.localeCompare(b.time)),
    );
    return mapping;
  }, [events, weekDays]);

  const openCreateDialog = (date: string, time?: string) => {
    setEditingEvent(null);
    setFormDate(date);
    setFormTime(time ?? '08:00');
    setFormTemplateId(templates[0]?.id ?? '');
    setFormNote('');
    setFormError(null);
    setDialogOpen(true);
  };

  const openEditDialog = (event: SchedulerEvent) => {
    setEditingEvent(event);
    setFormDate(event.date);
    setFormTime(event.time);
    setFormTemplateId(event.templateId);
    setFormNote(event.note ?? '');
    setFormError(null);
    setDialogOpen(true);
  };

  const resetDialog = () => {
    setDialogOpen(false);
    setEditingEvent(null);
    setFormError(null);
  };

  const handleSaveEvent = () => {
    if (!formTemplateId) {
      setFormError('Select a command template.');
      return;
    }
    if (!formDate) {
      setFormError('Pick a date.');
      return;
    }
    if (!formTime) {
      setFormError('Pick a time.');
      return;
    }

    if (editingEvent) {
      updateEvent(editingEvent.id, {
        templateId: formTemplateId,
        date: formDate,
        time: formTime,
        note: formNote || undefined,
      });
      addLog(`Updated schedule for ${formDate} ${formTime}.`, 'info');
    } else {
      const event: SchedulerEvent = {
        id: generateEventId(),
        templateId: formTemplateId,
        date: formDate,
        time: formTime,
        note: formNote || undefined,
        enabled: true,
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };
      addEvent(event);
      addLog(`Scheduled ${formDate} ${formTime}.`, 'success');
    }

    resetDialog();
  };

  const handleDeleteEvent = (event: SchedulerEvent) => {
    deleteEvent(event.id);
    addLog(`Removed schedule for ${event.date} ${event.time}.`, 'info');
  };

  const handleCopyDay = (date: string) => {
    const source = new Date(date);
    const target = new Date(source);
    target.setDate(source.getDate() + 1);
    copyDay(formatDateKey(source), formatDateKey(target));
    addLog(`Copied ${source.toDateString()} to ${target.toDateString()}.`, 'info');
  };

  const handleCopyWeek = () => {
    copyWeek(formatDateKey(selectedWeekStart));
    const target = new Date(selectedWeekStart);
    target.setDate(target.getDate() + 7);
    addLog(
      `Copied week of ${selectedWeekStart.toDateString()} to week of ${target.toDateString()}.`,
      'info',
    );
  };

  const templatesById = useMemo(() => {
    const mapping = new Map<string, CommandTemplate>();
    templates.forEach((template) => mapping.set(template.id, template));
    return mapping;
  }, [templates]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const interval = setInterval(() => {
      const now = new Date();
      const dateKey = formatDateKey(now);
      const timeKey = `${padTimeValue(now.getHours())}:${padTimeValue(now.getMinutes())}`;

      events.forEach((event) => {
        if (!event.enabled || event.date !== dateKey || event.time !== timeKey) {
          return;
        }
        if (event.lastRunAt && event.lastRunAt.slice(0, 16) === now.toISOString().slice(0, 16)) {
          return;
        }

        const template = templatesById.get(event.templateId);
        if (!template) {
          addLog(`Scheduled command missing template (${event.templateId}).`, 'error');
          return;
        }

        mutation.mutate(
          {
            target: template.target,
            name: template.commandName,
            params: template.params,
          },
          {
            onSuccess: () => {
              addLog(`Executed ${template.label} at ${dateKey} ${timeKey}.`, 'success');
              markExecuted(event.id, now.toISOString());
            },
            onError: (error) => {
              addLog(
                `Failed to execute ${template.label}: ${
                  error instanceof Error ? error.message : 'unknown error'
                }.`,
                'error',
              );
            },
          },
        );
      });
    }, 30_000);

    return () => clearInterval(interval);
  }, [active, events, templatesById, mutation, addLog, markExecuted]);

  const toggleActive = () => {
    const next = !active;
    setActive(next);
    addLog(next ? 'Scheduler activated.' : 'Scheduler stopped.', 'info');
  };

  const goToToday = () => setSelectedWeekStart(beginningOfWeek(new Date()));
  const goToPreviousWeek = () => {
    const prev = new Date(selectedWeekStart);
    prev.setDate(prev.getDate() - 7);
    setSelectedWeekStart(beginningOfWeek(prev));
  };
  const goToNextWeek = () => {
    const next = new Date(selectedWeekStart);
    next.setDate(next.getDate() + 7);
    setSelectedWeekStart(beginningOfWeek(next));
  };

  return (
    <section className="panel scheduler">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Scheduler</h1>
          <p className="panel__subtitle">
            Plan ahead by attaching command templates to specific times. Start the scheduler to let
            the system dispatch commands automatically.
          </p>
        </div>
        <div className="scheduler-controls">
          <span className={`scheduler-status ${active ? 'is-active' : 'is-stopped'}`}>
            {active ? 'Active' : 'Stopped'}
          </span>
          <button type="button" onClick={toggleActive} className="scheduler-toggle">
            {active ? 'Stop Scheduler' : 'Start Scheduler'}
          </button>
        </div>
      </header>

      <div className="scheduler-toolbar">
        <div className="scheduler-week-nav">
          <button type="button" onClick={goToPreviousWeek}>
            &lt; Prev
          </button>
          <button type="button" onClick={goToToday}>
            Today
          </button>
          <button type="button" onClick={goToNextWeek}>
            Next &gt;
          </button>
          <span className="scheduler-week-range">
            Week of {selectedWeekStart.toLocaleDateString()}
          </span>
        </div>
        <div className="scheduler-week-actions">
          <button type="button" onClick={handleCopyWeek}>
            Copy Week -&gt; Next
          </button>
        </div>
      </div>

      <div className="scheduler-grid">
        {weekDays.map((day) => {
          const dayKey = formatDateKey(day);
          const dayEvents = eventsByDay[dayKey] ?? [];
          return (
            <section key={dayKey} className="scheduler-day">
              <header className="scheduler-day__header">
                <div>
                  <h2>
                    {day.toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </h2>
                  <span>{dayEvents.length} scheduled</span>
                </div>
                <div className="scheduler-day__actions">
                  <button type="button" onClick={() => openCreateDialog(dayKey)}>
                    + Add
                  </button>
                  <button type="button" onClick={() => handleCopyDay(dayKey)}>
                    Copy -&gt; Next Day
                  </button>
                </div>
              </header>
              <ul className="scheduler-day__events">
                {dayEvents.length === 0 ? (
                  <li className="scheduler-day__empty">No commands scheduled.</li>
                ) : (
                  dayEvents.map((event) => {
                    const template = templatesById.get(event.templateId);
                    return (
                      <li key={event.id} className="scheduler-event">
                        <div>
                          <strong>{formatTimeDisplay(event.time)}</strong>
                          <span>{template?.label ?? 'Missing template'}</span>
                          {event.note ? <small>{event.note}</small> : null}
                        </div>
                        <div className="scheduler-event__actions">
                          <button type="button" onClick={() => openEditDialog(event)}>
                            Edit
                          </button>
                          <button type="button" onClick={() => handleDeleteEvent(event)}>
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </section>
          );
        })}
      </div>

      {dialogOpen ? (
        <div className="scheduler-dialog">
          <div className="scheduler-dialog__body">
            <h3>{editingEvent ? 'Edit Scheduled Command' : 'Schedule Command'}</h3>
            <div className="scheduler-dialog__form">
              <label>
                Date
                <input
                  type="date"
                  value={formDate}
                  onChange={(event) => setFormDate(event.target.value)}
                />
              </label>
              <label>
                Time
                <input
                  type="time"
                  value={formTime}
                  onChange={(event) => setFormTime(event.target.value)}
                />
              </label>
              <label>
                Command Template
                <select
                  value={formTemplateId}
                  onChange={(event) => setFormTemplateId(event.target.value)}
                >
                  <option value="" disabled>
                    Select template
                  </option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note (optional)
                <input value={formNote} onChange={(event) => setFormNote(event.target.value)} />
              </label>
              {formError ? <span className="form-error">{formError}</span> : null}
            </div>
            <div className="scheduler-dialog__actions">
              <button type="button" onClick={handleSaveEvent}>
                {editingEvent ? 'Update' : 'Save'}
              </button>
              <button type="button" onClick={resetDialog}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="scheduler-logs">
        <header>
          <h3>Activity Log</h3>
        </header>
        <ul>
          {logs.length === 0 ? (
            <li className="scheduler-log__empty">No activity yet.</li>
          ) : (
            logs
              .slice()
              .reverse()
              .map((entry) => (
                <li key={entry.id} className={`scheduler-log scheduler-log--${entry.level}`}>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                  <p>{entry.message}</p>
                </li>
              ))
          )}
        </ul>
      </section>
    </section>
  );
}

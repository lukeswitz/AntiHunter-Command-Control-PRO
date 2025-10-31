import { useMutation } from '@tanstack/react-query';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '../api/client';
import { CommandRequest, CommandResponse } from '../api/types';
import {
  COMMAND_GROUP_ORDER,
  CommandDefinition,
  CommandParameter,
  MESH_COMMANDS,
} from '../data/mesh-commands';
import { useAuthStore } from '../stores/auth-store';
import { NodeSummary, useNodeStore } from '../stores/node-store';
import { useTemplateStore, CommandTemplate } from '../stores/template-store';
import { TerminalLevel, useTerminalStore } from '../stores/terminal-store';

type CommandFormState = {
  target: string;
  paramValues: Record<string, string>;
  includeForever: boolean;
};

type TerminalEntryInput = {
  message: string;
  level: TerminalLevel;
  source: string;
  timestamp?: string;
};

const defaultCommand = MESH_COMMANDS[0];

const createTemplateId = () => {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return `tmpl-${window.crypto.randomUUID()}`;
  }
  return `tmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

function normalizeTarget(value: string | undefined): string {
  if (!value) {
    return '@ALL';
  }
  const trimmed = value.trim().toUpperCase();
  const withoutAt = trimmed.replace(/^@/, '');
  const sanitized = withoutAt.startsWith('NODE_AH') ? withoutAt.replace(/^NODE_/, '') : withoutAt;
  return `@${sanitized}`;
}

function createFormState(
  command: CommandDefinition,
  preset?: { target?: string; params?: string[] },
): CommandFormState {
  const presetParams = preset?.params ?? command.examples?.[0]?.params ?? [];
  const paramValues: Record<string, string> = {};

  command.parameters.forEach((param, index) => {
    const exampleValue = presetParams[index];
    if (exampleValue && exampleValue !== 'FOREVER') {
      paramValues[param.key] = exampleValue;
      return;
    }
    if (param.type === 'select' && param.options?.length) {
      paramValues[param.key] = param.options[0].value;
      return;
    }
    paramValues[param.key] = '';
  });

  const includeForever =
    command.allowForever === true &&
    (presetParams.includes('FOREVER') || (preset?.params?.includes('FOREVER') ?? false));

  const targetCandidate =
    preset?.target ?? command.examples?.[0]?.target ?? command.defaultTarget ?? '@ALL';

  return {
    target: normalizeTarget(targetCandidate),
    paramValues,
    includeForever,
  };
}

function buildCommandParams(command: CommandDefinition, form: CommandFormState): string[] {
  const parts = command.parameters
    .map((param) => (form.paramValues[param.key] ?? '').trim())
    .filter((value) => value.length > 0);

  if (command.allowForever && form.includeForever) {
    parts.push('FOREVER');
  }

  return parts;
}

function parseCommandText(
  commandText: string,
): { target: string; name: string; params: string[] } | null {
  const trimmed = commandText.trim();
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace <= 0) {
    return null;
  }
  const target = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1);
  if (!rest) {
    return null;
  }
  const segments = rest.split(':');
  const [name, ...paramSegments] = segments;
  return { target: normalizeTarget(target), name: name.toUpperCase(), params: paramSegments };
}

function normalizeParamValue(param: CommandParameter, raw: string): string {
  switch (param.type) {
    case 'duration':
    case 'number': {
      const digits = raw.replace(/[^\d]/g, '');
      if (!digits) {
        return '';
      }
      const numeric = Number(digits);
      const min = param.min ?? 0;
      const max = param.max ?? Number.MAX_SAFE_INTEGER;
      const clamped = Math.min(Math.max(numeric, min), max);
      return clamped.toString();
    }
    case 'channels':
      return raw.replace(/\s+/g, '');
    case 'pipeList':
      return raw.replace(/\s+/g, '').toUpperCase();
    case 'text':
    default:
      return raw.trim();
  }
}

function deriveNodeTarget(node: NodeSummary): { value: string; label: string } {
  const rawId = (node.id ?? '').toUpperCase().replace(/^@/, '').replace(/\s+/g, '');
  const rawName = (node.name ?? '').toUpperCase().replace(/\s+/g, '');

  const ahCandidate =
    (/^AH\d+$/.test(rawName) && rawName) ||
    (/^AH\d+$/.test(rawId) && rawId) ||
    (rawId.startsWith('NODE_') && /^AH\d+$/.test(rawId.slice(5)) ? rawId.slice(5) : null);

  const fallback = rawName || rawId;
  const labelBase = ahCandidate ?? fallback ?? 'UNKNOWN';
  const safeLabel = labelBase.replace(/^NODE_/, '') || 'UNKNOWN';

  return {
    value: normalizeTarget(safeLabel),
    label: safeLabel,
  };
}

export function CommandConsolePage() {
  const addEntry = useTerminalStore((state) => state.addEntry);
  const availableNodes = useNodeStore((state) =>
    state.order.map((id) => state.nodes[id]).filter((node): node is NodeSummary => Boolean(node)),
  );
  const templates = useTemplateStore((state) => state.templates);
  const addTemplateToStore = useTemplateStore((state) => state.addTemplate);
  const updateTemplateInStore = useTemplateStore((state) => state.updateTemplate);
  const deleteTemplateFromStore = useTemplateStore((state) => state.deleteTemplate);
  const role = useAuthStore((state) => state.user?.role ?? null);

  const canSendCommands = role === 'ADMIN' || role === 'OPERATOR';

  const commandMap = useMemo(() => new Map(MESH_COMMANDS.map((cmd) => [cmd.name, cmd])), []);
  const groupedCommands = useMemo(() => {
    return COMMAND_GROUP_ORDER.map((group) => ({
      group,
      commands: MESH_COMMANDS.filter((cmd) => cmd.group === group),
    })).filter((entry) => entry.commands.length > 0);
  }, []);

  const [selectedCommandName, setSelectedCommandName] = useState(defaultCommand.name);
  const selectedCommand = commandMap.get(selectedCommandName) ?? defaultCommand;
  const [form, setForm] = useState<CommandFormState>(() => createFormState(defaultCommand));
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [targetError, setTargetError] = useState<string | null>(null);
  const [customCommand, setCustomCommand] = useState('@ALL STATUS');
  const [customError, setCustomError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [templateError, setTemplateError] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleClickAway = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        selectorRef.current &&
        !selectorRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  const mutation = useMutation({
    mutationFn: (body: CommandRequest) => apiClient.post<CommandResponse>('/commands/send', body),
    onSuccess: (data) => {
      const entry: TerminalEntryInput = {
        message: `Command ${data.id} queued`,
        level: 'notice',
        source: 'command',
      };
      addEntry(entry);
    },
    onError: (error: unknown) => {
      const entry: TerminalEntryInput = {
        message: `Command failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        level: 'critical',
        source: 'command',
      };
      addEntry(entry);
    },
  });

  const nodeCommandTargets = useMemo(() => {
    const dedup = new Map<string, { value: string; label: string }>();
    availableNodes.forEach((node) => {
      const target = deriveNodeTarget(node);
      if (!dedup.has(target.value)) {
        dedup.set(target.value, target);
      }
    });
    return Array.from(dedup.values());
  }, [availableNodes]);

  const targetOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: '@ALL', label: '@ALL (broadcast)' },
      ...nodeCommandTargets,
    ];

    if (form.target && !options.some((option) => option.value === normalizeTarget(form.target))) {
      const normalized = normalizeTarget(form.target);
      options.push({ value: normalized, label: normalized.replace(/^@/, '') });
    }

    return options;
  }, [nodeCommandTargets, form.target]);

  const paramsForCommand = useMemo(
    () => buildCommandParams(selectedCommand, form),
    [selectedCommand, form],
  );

  const commandPayload = useMemo(() => {
    if (paramsForCommand.length === 0) {
      return selectedCommand.name;
    }
    return `${selectedCommand.name}:${paramsForCommand.join(':')}`;
  }, [paramsForCommand, selectedCommand.name]);

  const preview = useMemo(() => {
    const target = form.target.trim();
    if (!target) {
      return commandPayload;
    }
    return `${target} ${commandPayload}`.trim();
  }, [form.target, commandPayload]);

  const setCommand = (
    command: CommandDefinition,
    preset?: { target?: string; params?: string[] },
  ) => {
    setSelectedCommandName(command.name);
    setForm(createFormState(command, preset));
    setParamErrors({});
    setTargetError(null);
    setMenuOpen(false);
  };

  const handleParamInputChange = (param: CommandParameter, rawValue: string) => {
    const value = normalizeParamValue(param, rawValue);
    setForm((prev) => ({
      ...prev,
      paramValues: {
        ...prev.paramValues,
        [param.key]: value,
      },
    }));
    setParamErrors((prev) => {
      if (!prev[param.key]) {
        return prev;
      }
      const next = { ...prev };
      delete next[param.key];
      return next;
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setCustomError(null);
    const trimmedTarget = form.target.trim();
    const errors: Record<string, string> = {};
    selectedCommand.parameters.forEach((param) => {
      const value = (form.paramValues[param.key] ?? '').trim();
      if (param.required && !value) {
        errors[param.key] = 'Required';
      }
    });
    setParamErrors(errors);
    if (!trimmedTarget) {
      setTargetError('Target is required');
    } else {
      setTargetError(null);
    }
    if (Object.keys(errors).length > 0 || !trimmedTarget) {
      return;
    }

    if (!canSendCommands) {
      setTargetError('You do not have permission to send commands.');
      return;
    }

    mutation.mutate({
      target: trimmedTarget,
      name: selectedCommand.name,
      params: paramsForCommand,
    });
  };

  const handleSaveTemplate = () => {
    const trimmedName = newTemplateName.trim();
    if (!trimmedName) {
      setTemplateError('Template name is required');
      return;
    }
    const lower = trimmedName.toLowerCase();
    if (templates.some((template) => template.label.toLowerCase() === lower)) {
      setTemplateError('A template with this name already exists');
      return;
    }
    const target = form.target.trim() || '@ALL';
    const params = paramsForCommand;
    const id = createTemplateId();
    const template: CommandTemplate = {
      id,
      label: trimmedName,
      commandName: selectedCommand.name,
      target,
      params,
    };
    addTemplateToStore(template);
    setNewTemplateName('');
    setTemplateError(null);
    setEditingTemplateId(null);
  };

  const handleTemplateUse = (template: CommandTemplate) => {
    const definition = commandMap.get(template.commandName);
    if (!definition) {
      return;
    }
    setCommand(definition, { target: template.target, params: template.params });
    setEditingTemplateId(null);
    setNewTemplateName('');
    setTemplateError(null);
  };

  const handleTemplateEdit = (template: CommandTemplate) => {
    const definition = commandMap.get(template.commandName);
    if (!definition) {
      return;
    }
    setCommand(definition, { target: template.target, params: template.params });
    setNewTemplateName(template.label);
    setEditingTemplateId(template.id);
    setTemplateError(null);
  };

  const handleDeleteTemplate = (templateId: string) => {
    deleteTemplateFromStore(templateId);
    if (editingTemplateId === templateId) {
      setEditingTemplateId(null);
      setNewTemplateName('');
      setTemplateError(null);
    }
  };

  const handleUpdateTemplate = () => {
    if (!editingTemplateId) {
      return;
    }
    const trimmedName = newTemplateName.trim();
    if (!trimmedName) {
      setTemplateError('Template name is required');
      return;
    }
    const lower = trimmedName.toLowerCase();
    if (
      templates.some(
        (template) => template.id !== editingTemplateId && template.label.toLowerCase() === lower,
      )
    ) {
      setTemplateError('Another template already uses this name');
      return;
    }
    const target = form.target.trim() || '@ALL';
    const params = paramsForCommand;
    updateTemplateInStore(editingTemplateId, {
      label: trimmedName,
      commandName: selectedCommand.name,
      target,
      params,
    });
    setTemplateError(null);
  };

  const handleCancelTemplateEdit = () => {
    setEditingTemplateId(null);
    setNewTemplateName('');
    setTemplateError(null);
  };

  const handleCustomSubmit = () => {
    const commandLine = customCommand.trim();
    if (!commandLine) {
      setCustomError('Command line is required.');
      return;
    }

    const parsed = parseCommandText(commandLine);
    if (!parsed) {
      setCustomError('Invalid command format. Expected "@TARGET COMMAND[:param]".');
      return;
    }

    if (!canSendCommands) {
      setCustomError('You do not have permission to send commands.');
      return;
    }

    setCustomError(null);
    mutation.mutate({
      target: parsed.target,
      name: parsed.name,
      params: parsed.params,
    });
  };

  return (
    <section className="panel command-console">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Command Console</h1>
          <p className="panel__subtitle">
            Choose a command, fill in typed parameters, and queue it to the mesh. The left rail
            includes curated templates for quick reuse. Save your own templates when you find a
            useful configuration.
          </p>
        </div>
      </header>

      <div className="console-layout">
        <form className="console-form" onSubmit={handleSubmit}>
          <div className="form-row">
            <label htmlFor="command-selector">Command</label>
            <div className="command-selector-wrapper">
              <button
                id="command-selector"
                ref={selectorRef}
                type="button"
                className="command-selector"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
              >
                <span>{selectedCommand.name}</span>
                <span className="command-selector__group">{selectedCommand.group}</span>
                <span className="command-selector__chevron" aria-hidden>
                  ?
                </span>
              </button>
              {menuOpen ? (
                <div className="command-menu" ref={menuRef}>
                  {groupedCommands.map(({ group, commands }) => (
                    <div key={group} className="command-menu__group">
                      <div className="command-menu__title">{group}</div>
                      {commands.map((command) => (
                        <button
                          key={command.name}
                          type="button"
                          className={`command-menu__item ${command.name === selectedCommand.name ? 'is-active' : ''}`}
                          onClick={() => setCommand(command)}
                        >
                          <span className="command-menu__item-name">{command.name}</span>
                          <span className="command-menu__item-desc">{command.description}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="form-row">
            <div className="form-label">Description</div>
            <p className="command-description">{selectedCommand.description}</p>
          </div>

          <div className="form-row">
            <label htmlFor="command-target">Target</label>
            <select
              id="command-target"
              value={form.target}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  target: normalizeTarget(event.target.value),
                }))
              }
            >
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {targetError ? <span className="form-error">{targetError}</span> : null}
          </div>

          {selectedCommand.parameters.length > 0 ? (
            <div className="form-row">
              <div className="form-label">Parameters</div>
              <div className="form-parameters">
                {selectedCommand.parameters.map((param) => {
                  const value = form.paramValues[param.key] ?? '';
                  return (
                    <div key={param.key} className="parameter-field">
                      <div className="parameter-label">
                        <span>{param.label}</span>
                        {param.required ? <span className="parameter-required">*</span> : null}
                      </div>
                      {param.type === 'select' ? (
                        <select
                          value={value}
                          onChange={(event) => handleParamInputChange(param, event.target.value)}
                        >
                          {param.options?.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="parameter-control">
                          <input
                            value={value}
                            onChange={(event) => handleParamInputChange(param, event.target.value)}
                            placeholder={param.placeholder}
                            type={
                              param.type === 'duration' || param.type === 'number'
                                ? 'number'
                                : 'text'
                            }
                            inputMode={
                              param.type === 'duration' || param.type === 'number'
                                ? 'numeric'
                                : undefined
                            }
                            min={param.min}
                            max={param.max}
                            step={
                              param.step ??
                              (param.type === 'duration' || param.type === 'number' ? 1 : undefined)
                            }
                          />
                          {param.suffix ? (
                            <span className="parameter-suffix">{param.suffix}</span>
                          ) : null}
                        </div>
                      )}
                      {param.helper ? <small>{param.helper}</small> : null}
                      {paramErrors[param.key] ? (
                        <span className="form-error">{paramErrors[param.key]}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {selectedCommand.allowForever ? (
            <div className="form-row forever-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={form.includeForever}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      includeForever: event.target.checked,
                    }))
                  }
                />
                Append FOREVER
              </label>
              <span>Command continues until a STOP is issued.</span>
            </div>
          ) : null}

          <div className="form-row">
            <div className="form-label">Preview</div>
            <code className="preview-line">{preview || 'N/A'}</code>
          </div>

          <button
            type="submit"
            className="submit-button"
            disabled={mutation.isPending || !canSendCommands}
          >
            {mutation.isPending ? 'Sending...' : 'Send Command'}
          </button>

          <div className="form-divider" />

          <div className="custom-command">
            <label htmlFor="custom-command">Custom Command</label>
            <textarea
              id="custom-command"
              className="custom-command__input"
              rows={3}
              value={customCommand}
              onChange={(event) => setCustomCommand(event.target.value)}
              placeholder="@ALL STATUS"
            />
            {customError ? <span className="form-error">{customError}</span> : null}
            <button
              type="button"
              className="secondary-button"
              onClick={handleCustomSubmit}
              disabled={mutation.isPending || !canSendCommands}
            >
              Send Raw Command
            </button>
          </div>

          <div className="form-row template-save">
            <label htmlFor="template-name">Save as Template</label>
            <div className="template-save__controls">
              <input
                id="template-name"
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
                placeholder="Template name (e.g., Nightly scan)"
              />
              {editingTemplateId ? (
                <>
                  <button type="button" onClick={handleUpdateTemplate}>
                    Update
                  </button>
                  <button
                    type="button"
                    className="template-cancel"
                    onClick={handleCancelTemplateEdit}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={handleSaveTemplate}>
                  Save
                </button>
              )}
            </div>
            {templateError ? <span className="form-error">{templateError}</span> : null}
          </div>

          {mutation.isError ? (
            <p className="error-text">Failed to send command. Check terminal for details.</p>
          ) : null}
          {mutation.isSuccess ? (
            <p className="success-text">Command queued. Track updates in the terminal.</p>
          ) : null}
        </form>

        <section className="console-templates console-templates--stacked">
          <h2>Command Templates</h2>
          <div className="template-list">
            {templates.map((template) => {
              const isEditingTemplate = editingTemplateId === template.id;
              return (
                <article
                  key={template.id}
                  className={`template-card${isEditingTemplate ? ' is-editing' : ''}`}
                >
                  <div className="template-card__header">
                    <div>
                      <strong>{template.label}</strong>
                      <span>{template.commandName}</span>
                    </div>
                    <div className="template-card__actions">
                      <button type="button" onClick={() => handleTemplateUse(template)}>
                        Use
                      </button>
                      <button type="button" onClick={() => handleTemplateEdit(template)}>
                        {isEditingTemplate ? 'Editing…' : 'Edit'}
                      </button>
                      <button
                        type="button"
                        className="template-delete template-card__delete"
                        aria-label={`Delete template ${template.label}`}
                        onClick={() => handleDeleteTemplate(template.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <p>
                    {template.description ??
                      `${template.target} ${[template.commandName, ...template.params].join(':')}`}
                  </p>
                </article>
              );
            })}
            {templates.length === 0 ? <p className="template-empty">No templates yet.</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}

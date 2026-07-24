/**
 * Pure template rendering for the Notification Center — no IO, fully testable.
 * Supports `{{var}}` interpolation and `{{#if var}}…{{/if}}` / `{{#unless}}`
 * conditional blocks, builds a provider-agnostic NotificationCard from the event
 * payload, and produces a per-provider NotificationMessage (picking the
 * channel-specific body when the template supplies one, else a safe fallback).
 */
import {
  cardToMarkdown,
  cardToSms,
  cardToText,
  type NotificationButton,
  type NotificationCard,
  type NotificationKind,
  type NotificationMessage,
} from './notification-provider';

export interface TemplateBodies {
  subject?: string | null;
  title?: string | null;
  subtitle?: string | null;
  html?: string | null;
  text?: string | null;
  markdown?: string | null;
  sms?: string | null;
  whatsapp?: string | null;
  telegram?: string | null;
  /** Optional card overrides: { overviewVar?, posterVar?, backdropVar?, buttons: [{label,urlVar}], badgeVars: [] } */
  card?: Record<string, unknown> | null;
}

export type TemplateVars = Record<string, unknown>;

function toStr(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v) && v !== '0' && v !== 'false';
}

/** Resolve `{{#if x}}…{{/if}}` and `{{#unless x}}…{{/unless}}` blocks (non-nested). */
export function evalConditionals(tpl: string, vars: TemplateVars): string {
  let out = tpl;
  out = out.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key, body) => (truthy(vars[key]) ? body : ''));
  out = out.replace(/\{\{#unless\s+([\w.]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_m, key, body) => (!truthy(vars[key]) ? body : ''));
  return out;
}

/** Replace `{{var}}` with the (stringified) variable value. Unknown vars → ''. */
export function interpolate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => toStr(vars[key]));
}

export function renderString(tpl: string | null | undefined, vars: TemplateVars): string {
  if (!tpl) return '';
  return interpolate(evalConditionals(tpl, vars), vars).trim();
}

/** Build the provider-agnostic rich card from a template + event variables. */
export function buildCard(tpl: TemplateBodies, vars: TemplateVars): NotificationCard {
  const badges: string[] = [];
  for (const b of [vars.year, vars.resolution, vars.quality, vars.runtimeLabel, vars.libraryName, vars.serverName]) {
    if (b != null && String(b).trim()) badges.push(String(b));
  }
  const genres = Array.isArray(vars.genres) ? (vars.genres as string[]) : typeof vars.genres === 'string' && vars.genres ? String(vars.genres).split(/,\s*/) : [];

  const buttons: NotificationButton[] = [];
  const cardDef = tpl.card ?? {};
  const defBtns = Array.isArray((cardDef as { buttons?: unknown }).buttons) ? ((cardDef as { buttons: { label: string; urlVar?: string; url?: string }[] }).buttons) : [];
  for (const b of defBtns) {
    const url = b.url ? interpolate(b.url, vars) : b.urlVar ? toStr(vars[b.urlVar]) : '';
    if (url) buttons.push({ label: b.label, url });
  }
  if (!buttons.length && vars.watchUrl) buttons.push({ label: 'View', url: toStr(vars.watchUrl) });

  const ratingNum = vars.rating != null && vars.rating !== '' ? Number(vars.rating) : null;

  return {
    title: renderString(tpl.title, vars) || toStr(vars.mediaTitle) || toStr(vars.title) || renderString(tpl.subject, vars) || 'Notification',
    subtitle: renderString(tpl.subtitle, vars) || toStr(vars.episodeTitle) || null,
    // `actorName` is set from the event payload only — deliberately NOT
    // `userDisplayName`, which the pipeline falls back to the recipient's name.
    actor: toStr(vars.actorName) || null,
    action: toStr(vars.actionLabel) || null,
    overview: toStr(vars.overview) || null,
    posterUrl: toStr(vars.posterUrl) || null,
    backdropUrl: toStr(vars.backdropUrl) || null,
    badges,
    rating: ratingNum != null && Number.isFinite(ratingNum) ? ratingNum : null,
    genres,
    runtime: vars.runtime != null && vars.runtime !== '' ? Number(vars.runtime) : null,
    buttons,
    footer: renderString(tpl.card && (tpl.card as { footer?: string }).footer ? String((tpl.card as { footer?: string }).footer) : '', vars) || toStr(vars.serverName) || null,
    timestamp: toStr(vars.eventTime) || toStr(vars.startedAt) || null,
  };
}

/**
 * Produce a NotificationMessage tailored to the target provider kind — picks the
 * channel-specific template body when present, otherwise a capability-appropriate
 * fallback derived from the card.
 */
export function buildMessage(tpl: TemplateBodies, vars: TemplateVars, kind: NotificationKind): NotificationMessage {
  const card = buildCard(tpl, vars);
  const subject = renderString(tpl.subject, vars) || card.title;

  let text: string;
  let markdown: string | undefined;
  let html: string | undefined;

  switch (kind) {
    case 'sms':
      text = renderString(tpl.sms, vars) || cardToSms(card);
      break;
    case 'telegram':
      markdown = renderString(tpl.telegram, vars) || renderString(tpl.markdown, vars) || cardToMarkdown(card);
      text = renderString(tpl.text, vars) || cardToText(card);
      break;
    case 'whatsapp':
      text = renderString(tpl.whatsapp, vars) || renderString(tpl.text, vars) || cardToText(card);
      markdown = renderString(tpl.whatsapp, vars) || undefined;
      break;
    case 'email':
      html = renderString(tpl.html, vars) || undefined;
      text = renderString(tpl.text, vars) || cardToText(card);
      break;
    default:
      text = renderString(tpl.text, vars) || cardToText(card);
  }

  return { subject, card, text, html: html ?? null, markdown: markdown ?? null };
}

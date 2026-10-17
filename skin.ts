export const SKIN_CSS = String.raw`
/* Grok Bot chat skin.
   bb's timeline is virtualised: it measures each row as it mounts and positions the rest
   from those heights. Anything that changes a row's height afterwards makes the list
   correct its scroll position on every row you scroll past, so every rule that affects
   height keys on what bb itself renders at mount (row ids, the author directive) and
   never on attributes a script adds later. */
html{
  --gb-avatar:34px;
  --gb-bot-bubble:color-mix(in oklch, var(--ink) 6%, var(--canvas));
  --gb-me-bubble:color-mix(in oklch, var(--ink) 88%, var(--canvas));
  --gb-me-ink:var(--canvas);
}

/* Sidebar: a bot thread's face before its title (faceCss sets content per thread) */
.bb-thread-title::before{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:-3px;
  margin-right:6px;width:16px;height:16px;border-radius:9999px;color:white;font-size:10px;font-weight:600}

/* Bot messages: the author directive renders the face and name; the skin lays them out
   around a rounded bubble. Only Grok Bot messages carry the directive. */
[data-timeline-row-id*=":assistant:"]:has([data-gb-author]) > [data-message-column]{position:relative;
  padding-left:calc(var(--gb-avatar) + 12px) !important;padding-top:20px !important;max-width:760px}
[data-timeline-row-id*=":assistant:"] [data-markdown-preview]:has(> :first-child [data-gb-author]){
  background:var(--gb-bot-bubble);border-radius:6px 18px 18px 18px;padding:9px 14px 9px 11px;display:inline-block;
  border-left:3px solid var(--gb-color,transparent);
  max-width:100%;min-height:var(--gb-avatar);position:static !important}
/* bb wraps the directive in a display:contents div, so the directive itself is the
   positioned box, anchored to the message column (the markdown wrappers stay static) */
[data-message-column] [data-gb-author]{display:block !important;position:absolute !important;left:0;top:0;width:100%;height:0;margin:0 !important}
[data-gb-author] > [data-gb-face]{position:absolute;left:0;top:20px}
[data-gb-author] > [data-gb-name]{position:absolute;left:calc(var(--gb-avatar) + 14px);top:0;line-height:16px;
  font-size:12px;font-weight:600;white-space:nowrap;color:var(--foreground)}

/* Group chats tint each bubble edge with the speaker's colour (set per bot in faceCss);
   the border is always there so the colour never changes a bubble's size */

/* You: right-hand dark bubble (colour only, so no height change) */
html[data-gb-thread] [data-timeline-row-id*=":user"] .rounded-xl{background:var(--gb-me-bubble) !important;
  color:var(--gb-me-ink) !important;border-radius:18px 18px 6px 18px !important;border:none !important}
html[data-gb-thread] [data-timeline-row-id*=":user"] .rounded-xl *{color:var(--gb-me-ink) !important}

/* You, typed in the Grok Bot app: bb draws these as collapsed "System Message" rows;
   flatten them into the same right-hand bubble */
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] .group\/timeline-row{display:none}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [style*="height"]{height:auto !important;overflow:visible !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [role="button"]{cursor:default;pointer-events:none;padding:4px 0 !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [role="button"] > div{padding:0 !important;margin:0 !important;display:flex;justify-content:flex-end}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [role="button"] > div::before{display:none !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] .truncate{overflow:visible !important;white-space:normal !important;text-overflow:clip !important;display:block !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] .truncate > span.shrink-0{display:none}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [data-markdown-preview]{background:var(--gb-me-bubble);border-radius:18px 18px 6px 18px;
  padding:9px 14px;max-width:min(80%,640px);margin-left:auto;text-align:left}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [data-markdown-preview] *{color:var(--gb-me-ink) !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [data-markdown-preview] p{display:block !important;margin:0 0 .5em !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [data-markdown-preview] p:last-child{margin-bottom:0 !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [data-markdown-preview] li{display:list-item !important}
html[data-gb-thread] [data-timeline-row-id*=":provider-input:"] [data-markdown-preview] :is(ul,ol){padding-left:1.2em !important}

/* Plumbing rows (register/sync messages) */
[data-gb-hide]{display:none !important}
`;

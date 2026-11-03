/**
 * `turndown-plugin-gfm` ships no type declarations and none exist on
 * DefinitelyTyped. Minimal shim covering the one export we use (the combined
 * GFM plugin: tables, strikethrough, task lists) against `TurndownService`.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}

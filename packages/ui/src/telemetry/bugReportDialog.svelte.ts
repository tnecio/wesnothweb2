/**
 * Phase 30: whether "Report a bug" is open, and for which error if it was opened from the error screen. One
 * dialog for the whole app (`App.svelte` renders `BugReportDialog`); the game menu, the title screen and the
 * error screen open it.
 */
import type { CapturedError } from '../errors/errorReporting.svelte.js';

export const bugReportDialog = $state<{ open: boolean; crash: CapturedError | null }>({ open: false, crash: null });

export function openBugReport(crash: CapturedError | null = null): void {
  bugReportDialog.crash = crash;
  bugReportDialog.open = true;
}

export function closeBugReport(): void {
  bugReportDialog.open = false;
  bugReportDialog.crash = null;
}

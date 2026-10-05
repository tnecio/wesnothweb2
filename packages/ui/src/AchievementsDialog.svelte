<script lang="ts">
  /**
   * Phase 25: the achievements dialog (`gui2::dialogs::achievements_dialog`, `achievements_dialog.cfg`):
   * from the title screen's Achievements button, the game menu and Ctrl+Shift+A. A menu picks the content
   * (the last one picked is remembered, as upstream's `selected_achievement_group` preference); each
   * achievement shows its icon (greyed until earned), its name -- gold once earned, with `(count/total)` and
   * a bar while in progress -- its description and its sub-achievements' icons. Hidden ones show only once
   * earned. "Completed $count/$total" counts the group.
   */
  import Modal from './Modal.svelte';
  import IpfImage from './images/IpfImage.svelte';
  import type { AchievementGroupView } from '@wesnothweb2/engine';
  import { fmt, t } from './i18n/locale.js';
  import Markup from './markup/Markup.svelte';

  let { groups, onClose }: { groups: readonly AchievementGroupView[]; onClose: () => void } = $props();

  const SELECTED_KEY = 'wesnothweb2.achievementGroup';

  function initialIndex(): number {
    let last = '';
    try {
      last = localStorage.getItem(SELECTED_KEY) ?? '';
    } catch {
      /* none remembered */
    }
    const i = groups.findIndex((g) => g.contentFor === last);
    return i >= 0 ? i : 0;
  }

  let selected = $state(initialIndex());
  let group = $derived(groups[selected]);

  function choose(i: number): void {
    selected = i;
    try {
      localStorage.setItem(SELECTED_KEY, groups[i]?.contentFor ?? '');
    } catch {
      /* not remembered */
    }
  }
</script>

<Modal width="46rem" labelledBy={t('Achievements')} {onClose}>
  {#snippet children()}
    <div class="head">
      <div class="title">{t('Achievements')}</div>
      {#if groups.length > 0}
        <select value={selected} onchange={(e) => choose(Number(e.currentTarget.value))} aria-label={t('Achievements')} data-testid="achievements-group">
          {#each groups as g, i (g.contentFor)}
            <option value={i}>{g.displayName}</option>
          {/each}
        </select>
      {/if}
    </div>
    <ul class="list" data-testid="achievements-list">
      {#each group?.achievements ?? [] as a (a.id)}
        <li class:achieved={a.achieved} data-testid={`achievement-${a.id}`}>
          <IpfImage class="icon" src={a.icon} />
          <div class="text">
            <div class="name">{a.progress ? fmt(t('$title ($count/$total)'), { title: a.name, count: a.progress.current, total: a.progress.max }) : a.name}</div>
            <div class="description"><Markup text={a.description} /></div>
            {#if a.progressPercent !== null}
              <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(a.progressPercent)}>
                <div class="fill" style:width="{a.progressPercent}%"></div>
              </div>
            {/if}
            {#if a.subAchievements.length > 0}
              <div class="subs">
                {#each a.subAchievements as s (s.id)}
                  <span title={s.description}><IpfImage class="sub-icon" src={s.icon} alt={s.description} /></span>
                {/each}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <div class="footer">
      <span class="count" data-testid="achievements-count">{group ? fmt(t('Completed $count/$total'), { count: group.completed, total: group.total }) : ''}</span>
      <div class="spacer"></div>
      <button class="primary" data-autofocus onclick={onClose}>{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
  }
  select {
    font: inherit;
    background: #0e1420;
    color: inherit;
    border: 1px solid #4a4432;
    border-radius: 3px;
    padding: 0.2rem 0.4rem;
    max-width: 60%;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 60vh;
    overflow-y: auto;
  }
  .list li {
    display: flex;
    gap: 0.7rem;
    padding: 0.5rem 0.3rem;
    border-bottom: 1px solid #241f1a;
  }
  * :global(.icon) {
    flex: 0 0 auto;
    width: 72px;
    height: 72px;
    object-fit: contain;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .name {
    font-size: 1.1rem;
    font-weight: 700;
    color: #d7cba8;
  }
  .achieved .name {
    color: #e4c860;
  }
  .description {
    font-size: 0.85rem;
    margin-top: 0.2rem;
  }
  .achieved .description {
    color: #6fd66f;
  }
  .bar {
    margin-top: 0.3rem;
    height: 0.5rem;
    background: #1a1712;
    border: 1px solid #4a4432;
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #c9a63a;
  }
  .subs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
    margin-top: 0.3rem;
  }
  * :global(.sub-icon) {
    width: 28px;
    height: 28px;
    object-fit: contain;
  }
  .footer {
    display: flex;
    align-items: center;
    margin-top: 0.6rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .footer button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #4a8ab8;
    background: #2a5a86;
    color: #d7e8f5;
    cursor: pointer;
  }
</style>

/**
 * The five-line preview of a house.
 *
 * Shared by the hover tooltip on a desktop and the long-press sheet on a touch
 * device — they are the same question ("what is this building, briefly?") asked
 * with different hardware, and answering it two different ways would be two
 * things to keep in step.
 *
 * Deliberately short. Everything here is something a coordinator decides *with*
 * before opening the card: where it is, which precinct, how big, what stage,
 * how urgent, who owns it, when we were last there, and what is wrong.
 */

import { actionTypesById } from '../../../features/elections/electionsTypes.js';
import {
  campaignStateOf,
  formatApartments,
  formatAssignee,
  formatEntrances,
  formatPrecincts,
  formatShortDate,
  getHouseFlags,
  getPriority,
  getStage,
  resolveApartments,
  resolveEntrances,
} from '../../../features/elections/houseUtils.js';
import styles from '../ElectionsPage.module.css';

function HouseTooltip({ house }) {
  const state = campaignStateOf(house);
  const stage = getStage(house);
  const priority = getPriority(house);
  const flags = getHouseFlags(house);
  const entrances = resolveEntrances(house);
  const apartments = resolveApartments(house);

  const warnings = [
    flags.hasOverdueTasks ? `⚠ прострочених задач: ${state.overdueTasksCount}` : '',
    flags.hasOpenIssues ? `звернень: ${state.openIssuesCount}` : '',
  ].filter(Boolean);

  return (
    <>
      <strong>{house.address}</strong>

      <span>
        {formatPrecincts(house)} ·{' '}
        {entrances.value ? formatEntrances(entrances.value) : 'підʼїзди невідомі'} ·{' '}
        {formatApartments(apartments.value)}
      </span>

      <span className={styles.mapTooltipStatus}>
        Етап: {stage.label} · Пріоритет: {priority.label.toLowerCase()}
      </span>

      <span>
        Відповідальний:{' '}
        {state.assignees.length === 0
          ? 'не призначено'
          : state.assignees.map((assignee) => formatAssignee(assignee.email)).join(', ')}
      </span>

      <span>
        {state.lastActionAt
          ? `Останнє: ${
              actionTypesById[state.lastActionType]?.label?.toLowerCase() ?? 'дія'
            } ${formatShortDate(state.lastActionAt)}`
          : 'Дій ще не було'}
        {warnings.length > 0 ? ` · ${warnings.join(' · ')}` : ''}
      </span>

      <span className={styles.mapTooltipMeta}>
        {house.verifiedAt
          ? `Перевірено ${formatShortDate(house.verifiedAt)}`
          : 'Дані не перевірялися'}
      </span>
    </>
  );
}

export default HouseTooltip;

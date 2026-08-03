/**
 * «Основне» — what is happening with this building *in this campaign*.
 *
 * Deliberately the shortest section and deliberately the one that opens first:
 * it holds the six fields a coordinator actually changes on an ordinary day,
 * and nothing that describes the building itself. The permanent record lives
 * one section along, under «Характеристики будинку», because the two have
 * different lifetimes — a stage is true until Tuesday, an entrance count is
 * true until somebody rebuilds the house.
 *
 * Everything here is a draft until «Зберегти». See `useHouseEditor`.
 */

import {
  PRIORITIES,
  WORK_STAGES,
} from '../../../../features/elections/electionsTypes.js';
import {
  campaignStateOf,
  formatAssignee,
  formatDate,
  formatShortDate,
  getQualityFindings,
} from '../../../../features/elections/houseUtils.js';
import { actionTypesById } from '../../../../features/elections/electionsTypes.js';
import {
  Badge,
  Card,
  DateField,
  FieldGrid,
  ReadOnlyField,
  SelectField,
  TextAreaField,
  TextField,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

function MainSection({ house, draft, onChange, isReadOnly, campaign }) {
  const state = campaignStateOf(house);
  const findings = getQualityFindings(house);

  return (
    <>
      <Card
        hint={
          campaign
            ? `Стосується лише кампанії «${campaign.name}». Результати інших кампаній не змінюються.`
            : 'Стосується лише активної кампанії.'
        }
        icon="list"
        title="Стан у кампанії"
      >
        <FieldGrid>
          <SelectField
            disabled={isReadOnly}
            label="Етап роботи"
            onChange={(stage) => onChange({ stage })}
            options={WORK_STAGES}
            required
            value={draft.stage}
          />

          <SelectField
            disabled={isReadOnly}
            label="Пріоритет"
            onChange={(priority) => onChange({ priority })}
            options={PRIORITIES}
            required
            value={draft.priority}
          />

          <TextField
            disabled={isReadOnly}
            hint="Чому цей будинок важливіший за сусідній"
            label="Причина пріоритету"
            onChange={(priorityReason) => onChange({ priorityReason })}
            placeholder="Багато звернень, скоро збори ОСББ…"
            value={draft.priorityReason}
            wide
          />

          <TextField
            disabled={isReadOnly}
            label="Наступна задача"
            onChange={(nextStep) => onChange({ nextStep })}
            placeholder="Передзвонити голові ОСББ"
            value={draft.nextStep}
          />

          <DateField
            disabled={isReadOnly}
            label="Термін наступної дії"
            onChange={(nextActionAt) => onChange({ nextActionAt })}
            value={draft.nextActionAt}
          />
        </FieldGrid>

        <TextAreaField
          disabled={isReadOnly}
          hint="Одне-два речення про поточний стан роботи з будинком"
          label="Коротке резюме"
          onChange={(summary) => onChange({ summary })}
          placeholder="Обійшли 1–3 підʼїзд, домовились зайти в суботу"
          value={draft.summary}
        />
      </Card>

      <Card
        hint="Обчислюється з записаної роботи — редагується у відповідних розділах."
        icon="refresh"
        title="Поточна картина"
      >
        <FieldGrid columns={3}>
          <ReadOnlyField
            label="Остання дія"
            value={
              state.lastActionAt
                ? `${actionTypesById[state.lastActionType]?.label ?? 'Дія'} · ${
                  formatDate(state.lastActionAt)
                }`
                : 'дій ще не було'
            }
          />

          <ReadOnlyField
            label="Відкритих звернень"
            value={String(state.openIssuesCount || 0)}
          />

          <ReadOnlyField
            hint={
              state.overdueTasksCount > 0
                ? `прострочено: ${state.overdueTasksCount}`
                : undefined
            }
            label="Відкритих задач"
            value={String(state.openTasksCount || 0)}
          />

          <ReadOnlyField
            label="Відповідальні"
            value={
              state.assignees.length === 0
                ? 'не призначено'
                : state.assignees.map((one) => formatAssignee(one.email)).join(', ')
            }
          />

          <ReadOnlyField
            label="Дані перевірено"
            value={
              house.verifiedAt
                ? `${formatShortDate(house.verifiedAt)}${
                  house.verifiedBy ? ` · ${formatAssignee(house.verifiedBy)}` : ''
                }`
                : 'не перевірялися'
            }
          />

          <ReadOnlyField
            label="Стан змінив"
            value={
              state.updatedBy
                ? `${formatAssignee(state.updatedBy)} · ${formatShortDate(state.updatedAt)}`
                : '—'
            }
          />
        </FieldGrid>

        {findings.length > 0 && (
          <div className={styles.findings}>
            <span className={styles.findingsLabel}>Якість даних:</span>

            {/* Reported, never corrected automatically: each of these needs
                somebody who can go and check, not a rule that rewrites it. */}
            {findings.map((finding) => (
              <Badge key={finding.id} tone={finding.tone}>
                {finding.label}
              </Badge>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

export default MainSection;

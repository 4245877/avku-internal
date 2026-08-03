/**
 * «Характеристики будинку» — the permanent record of the building.
 *
 * None of it depends on a campaign: an entrance count, a managing company or a
 * door code is as true next year as it is today, which is why it is saved
 * through `PATCH /houses/:id` and needs a coordinator rather than any role.
 *
 * Two things are handled specially, and both for the same reason — they are
 * fields a text box would quietly get wrong:
 *
 *   • **the check date and its author.** There is no input for either. Ticking
 *     "я перевірив(ла)" makes the server stamp its own clock and the verified
 *     identity, which is the only version of that field worth keeping.
 *   • **the coordinates and the outline.** They decide where the building is on
 *     everybody's map, and a fat-fingered digit in a `lat` field moves it into
 *     the river. They live in their own guarded block below, behind a warning
 *     and an explicit unlock, and the outline is not editable here at all.
 */

import { useState } from 'react';

import { HOUSE_TYPES } from '../../../../features/elections/electionsTypes.js';
import { formatAssignee, formatDate } from '../../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Button,
  Card,
  CheckboxField,
  ConfirmButton,
  CountField,
  FieldGrid,
  FormStatus,
  ReadOnlyField,
  SelectField,
  TextAreaField,
  TextField,
} from './editorFields.jsx';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import {
  linkHousePrecinct,
  unlinkHousePrecinct,
} from '../../../../features/elections/electionsApi.js';
import styles from './HouseEditor.module.css';

/** `вул. Зодчих, 58, корпус 2` — what the address fields currently add up to. */
function previewAddress(draft) {
  const street = draft.streetShort.trim() || draft.street.trim();
  const number = [draft.number.trim(), draft.block.trim()].filter(Boolean).join(', ');

  return [
    [street, number].filter(Boolean).join(', '),
    draft.city.trim(),
    draft.postalCode.trim(),
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Precinct links, saved on their own.
 *
 * A building is filed under a polling station by a *row*, not by a column:
 * different entrances of the same house routinely vote at different stations,
 * and a single select could not say that. So this is a list with an add form
 * rather than a field.
 */
function PrecinctLinks({ house, precincts, campaignId, canEdit, onChanged }) {
  const [precinctId, setPrecinctId] = useState('');
  const [entrance, setEntrance] = useState('');
  const mutation = useEditorMutation();

  const options = precincts.map((precinct) => ({
    id: precinct.id,
    label: `№${precinct.number}${precinct.district ? ` · ${precinct.district}` : ''}`,
  }));

  async function add() {
    if (!precinctId) {
      return;
    }

    const saved = await mutation.run(
      () =>
        linkHousePrecinct(
          house.id,
          { precinctId, entrance: entrance.trim() },
          { campaignId },
        ),
      'Дільницю привʼязано.',
    );

    if (saved) {
      setPrecinctId('');
      setEntrance('');
      onChanged();
    }
  }

  return (
    <Card
      hint="Підʼїзди одного будинку можуть голосувати на різних дільницях."
      icon="pin"
      title="Виборча дільниця"
    >
      {house.precincts.length === 0
        ? <p className={styles.mutedLine}>Дільницю ще не вказано.</p>
        : (
          <ul className={styles.chipList}>
            {house.precincts.map((link) => (
              <li className={styles.chipRow} key={link.id}>
                <span>
                  <strong>№{link.precinctNumber}</strong>
                  {link.district && <small> · {link.district}</small>}
                  {link.entrance && <small> · підʼїзд {link.entrance}</small>}
                </span>

                {canEdit && (
                  <ConfirmButton
                    confirmLabel="Відвʼязати"
                    isBusy={mutation.isBusy}
                    onConfirm={async () => {
                      const done = await mutation.run(
                        () => unlinkHousePrecinct(link.id, { campaignId }),
                        'Звʼязок з дільницею прибрано.',
                      );

                      if (done) {
                        onChanged();
                      }

                      return Boolean(done);
                    }}
                    question="Прибрати звʼязок?"
                    variant="quiet"
                  >
                    <ElectionsIcon name="close" size={14} />
                    <span className="sr-only">Прибрати дільницю №{link.precinctNumber}</span>
                  </ConfirmButton>
                )}
              </li>
            ))}
          </ul>
        )}

      {canEdit && options.length > 0 && (
        <div className={styles.inlineForm}>
          <FieldGrid columns={3}>
            <SelectField
              label="Додати дільницю"
              onChange={setPrecinctId}
              options={options}
              placeholder="Виберіть дільницю"
              value={precinctId}
            />

            <TextField
              inputMode="numeric"
              label="Підʼїзд"
              onChange={setEntrance}
              placeholder="усі"
              value={entrance}
            />

            <div className={styles.inlineFormAction}>
              <Button
                disabled={!precinctId}
                icon="check"
                isBusy={mutation.isBusy}
                onClick={add}
                variant="ghost"
              >
                Привʼязати
              </Button>
            </div>
          </FieldGrid>
        </div>
      )}

      {canEdit && options.length === 0 && (
        <p className={styles.mutedLine}>
          Довідник дільниць порожній — його заповнює координатор у розділі дільниць.
        </p>
      )}

      <FormStatus error={mutation.error} notice={mutation.notice} />
    </Card>
  );
}

/**
 * Coordinates, behind a lock.
 *
 * The brief is explicit that geometry must not be changeable by accident
 * through an ordinary text form, and it is right: this pair of numbers is what
 * every other person's map draws, and the outline itself comes from
 * OpenStreetMap and is not ours to retype. The lock is not security — the
 * server takes whatever a coordinator sends — it is a speed bump in the one
 * place where a typo is invisible until somebody walks to the wrong building.
 */
function GeometryBlock({ house, canEdit }) {
  const [isUnlocked, setIsUnlocked] = useState(false);

  return (
    <Card icon="target" title="Координати та геометрія">
      <p className={styles.warningLine}>
        <ElectionsIcon name="warning" size={15} />
        Координати визначають, де будинок стоїть на карті у всіх користувачів.
        Контур будівлі береться з OpenStreetMap і тут не редагується.
      </p>

      <FieldGrid columns={3}>
        <ReadOnlyField
          label="Широта"
          value={house.location?.lat?.toFixed(6) ?? '—'}
        />
        <ReadOnlyField
          label="Довгота"
          value={house.location?.lon?.toFixed(6) ?? '—'}
        />
        <ReadOnlyField
          hint={house.footprint?.length ? undefined : 'контур відсутній'}
          label="Точок контуру"
          value={String(house.footprint?.length ?? 0)}
        />
      </FieldGrid>

      {isUnlocked
        ? (
          <div className={styles.geometryUnlocked}>
            <p>
              Щоб перемістити будинок, скористайтеся режимом редагування межі та
              картою — окремий контрольований режим із попередженням. Ручне
              введення координат у цій формі свідомо недоступне.
            </p>

            {house.osmType && house.osmId && (
              <a
                className={styles.externalLink}
                href={`https://www.openstreetmap.org/${house.osmType}/${house.osmId}`}
                rel="noreferrer noopener"
                target="_blank"
              >
                Перевірити обʼєкт в OpenStreetMap
                <ElectionsIcon name="link" size={13} />
              </a>
            )}

            <Button onClick={() => setIsUnlocked(false)} variant="quiet">
              Згорнути
            </Button>
          </div>
        )
        : canEdit && (
          <Button icon="edit" onClick={() => setIsUnlocked(true)} variant="quiet">
            Що робити, якщо будинок стоїть не там
          </Button>
        )}
    </Card>
  );
}

function BuildingSection({
  house,
  draft,
  onChange,
  errors,
  showErrors,
  isReadOnly,
  precincts,
  campaignId,
  onPrecinctsChanged,
}) {
  const errorOf = (field) => (showErrors ? errors[field] : undefined);

  return (
    <>
      <Card
        hint="Постійні дані про будівлю. Вони не залежать від кампанії."
        icon="pin"
        title="Адреса"
      >
        <p className={styles.addressPreview}>
          <span>Нормалізована адреса</span>
          <strong>{previewAddress(draft) || '—'}</strong>
        </p>

        <FieldGrid>
          <TextField
            disabled={isReadOnly}
            error={errorOf('street')}
            label="Вулиця"
            onChange={(street) => onChange({ street })}
            placeholder="вулиця Зодчих"
            required
            value={draft.street}
            wide
          />

          <TextField
            disabled={isReadOnly}
            hint="Як вулиця підписана на карті"
            label="Коротка назва вулиці"
            onChange={(streetShort) => onChange({ streetShort })}
            placeholder="вул. Зодчих"
            value={draft.streetShort}
          />

          <TextField
            disabled={isReadOnly}
            error={errorOf('number')}
            label="Номер"
            onChange={(number) => onChange({ number })}
            placeholder="58"
            required
            value={draft.number}
          />

          <TextField
            disabled={isReadOnly}
            hint="Корпус або літера, якщо є"
            label="Корпус / літера"
            onChange={(block) => onChange({ block })}
            placeholder="корпус 2"
            value={draft.block}
          />

          <TextField
            disabled={isReadOnly}
            label="Населений пункт"
            onChange={(city) => onChange({ city })}
            placeholder="Київ"
            value={draft.city}
          />

          <TextField
            disabled={isReadOnly}
            inputMode="numeric"
            label="Поштовий індекс"
            onChange={(postalCode) => onChange({ postalCode })}
            placeholder="03170"
            value={draft.postalCode}
          />
        </FieldGrid>
      </Card>

      <Card icon="building" title="Будівля">
        <FieldGrid>
          <SelectField
            disabled={isReadOnly}
            label="Тип будівлі"
            onChange={(type) => onChange({ type })}
            options={HOUSE_TYPES}
            value={draft.type}
          />

          <CountField
            disabled={isReadOnly}
            error={errorOf('floors')}
            label="Поверхів"
            onChange={(floors) => onChange({ floors })}
            placeholder="9"
            value={draft.floors}
          />

          <CountField
            disabled={isReadOnly}
            error={errorOf('entrances')}
            hint={
              house.estimate?.entrances
                ? `оціночно ${house.estimate.entrances}, за геометрією`
                : undefined
            }
            label="Підʼїздів"
            onChange={(entrances) => onChange({ entrances })}
            placeholder="—"
            value={draft.entrances}
          />

          <CountField
            disabled={isReadOnly}
            error={errorOf('apartments')}
            hint={
              house.estimate?.apartments
                ? `оціночно ${house.estimate.apartments}, за геометрією`
                : undefined
            }
            label="Квартир"
            onChange={(apartments) => onChange({ apartments })}
            placeholder="—"
            value={draft.apartments}
          />

          <CountField
            disabled={isReadOnly}
            error={errorOf('households')}
            label="Заселених квартир"
            onChange={(households) => onChange({ households })}
            placeholder="—"
            value={draft.households}
          />

          <CountField
            disabled={isReadOnly}
            error={errorOf('residentsCount')}
            hint={
              house.estimate?.residents
                ? `оціночно ${house.estimate.residents}, за геометрією`
                : undefined
            }
            label="Мешканців"
            onChange={(residentsCount) => onChange({ residentsCount })}
            placeholder="—"
            value={draft.residentsCount}
          />

          <CountField
            disabled={isReadOnly}
            error={errorOf('builtYear')}
            label="Рік побудови"
            onChange={(builtYear) => onChange({ builtYear })}
            placeholder="1978"
            value={draft.builtYear}
          />

          <TextField
            disabled={isReadOnly}
            label="Назва обʼєкта"
            onChange={(name) => onChange({ name })}
            placeholder="Школа №14, ЖК «Патріотика»"
            value={draft.name}
          />
        </FieldGrid>
      </Card>

      <Card icon="door" title="Доступ і обслуговування">
        <FieldGrid>
          <TextField
            disabled={isReadOnly}
            label="Керуюча організація"
            onChange={(managingOrg) => onChange({ managingOrg })}
            placeholder="ОСББ «Зодчих 58», ЖЕК, керуюча компанія"
            value={draft.managingOrg}
            wide
          />

          <TextField
            disabled={isReadOnly}
            hint="Звідки взяті дані: OSM, обхід, список ОСББ"
            label="Джерело даних"
            onChange={(source) => onChange({ source })}
            placeholder="обхід 12.05"
            value={draft.source}
          />
        </FieldGrid>

        <TextAreaField
          disabled={isReadOnly}
          hint="Постійна нотатка: код домофона, консьєрж, закритий двір, коли відчинено"
          label="Доступ у будинок"
          onChange={(accessNote) => onChange({ accessNote })}
          placeholder="Код 1234, консьєрж до 20:00, двір зачинений з боку вулиці"
          value={draft.accessNote}
        />
      </Card>

      <Card icon="check" title="Перевірка даних">
        <FieldGrid columns={2}>
          <ReadOnlyField
            hint="Дату й автора перевірки проставляє сервер"
            label="Останню перевірку зроблено"
            value={
              house.verifiedAt
                ? `${formatDate(house.verifiedAt)}${
                  house.verifiedBy ? ` · ${formatAssignee(house.verifiedBy)}` : ''
                }`
                : 'дані ще не перевірялися'
            }
          />
        </FieldGrid>

        <CheckboxField
          checked={draft.verified}
          disabled={isReadOnly}
          hint="Дата й автор запишуться автоматично під час збереження"
          label="Я перевірив(ла) ці дані на місці"
          onChange={(verified) => onChange({ verified })}
        />
      </Card>

      <PrecinctLinks
        campaignId={campaignId}
        canEdit={!isReadOnly}
        house={house}
        onChanged={onPrecinctsChanged}
        precincts={precincts}
      />

      <GeometryBlock canEdit={!isReadOnly} house={house} />
    </>
  );
}

export default BuildingSection;

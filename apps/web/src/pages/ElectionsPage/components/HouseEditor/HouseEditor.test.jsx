/**
 * The full-screen house editor, as a person actually meets it.
 *
 * Each block below is an acceptance criterion of the rebuild rather than a
 * rendering detail — and every one of them is a way the old cramped side form
 * could lose somebody's work:
 *
 *   • the ten sections exist and load lazily, so opening a house does not
 *     download its whole file;
 *   • the permanent record and the campaign state go to **different endpoints**
 *     — the whole point of the split, and the thing a single «Зберегти» button
 *     is most likely to quietly undo;
 *   • a rejected save keeps every typed value;
 *   • closing with unsaved changes asks first;
 *   • a double click creates one record, not two;
 *   • an archived campaign is readable and not writable;
 *   • switching house never shows the previous house's records.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import HouseEditor from './HouseEditor.jsx';
import { createEmptyCampaignState } from '../../../../features/elections/electionsTypes.js';

vi.mock('../../../../features/elections/electionsApi.js', () => ({
  saveHouseAttributes: vi.fn(),
  saveHouseState: vi.fn(),
  fetchHouse: vi.fn(),
  fetchHousePeople: vi.fn(async () => []),
  fetchHouseActions: vi.fn(async () => []),
  fetchHouseIssues: vi.fn(async () => []),
  fetchHouseTasks: vi.fn(async () => []),
  fetchHouseEvents: vi.fn(async () => []),
  fetchHouseAttachments: vi.fn(async () => []),
  fetchHouseHistory: vi.fn(async () => []),
  createHousePerson: vi.fn(async () => ({ id: 'p-new' })),
  deletePerson: vi.fn(async () => ({ ok: true })),
  deletePersonLink: vi.fn(async () => ({ ok: true })),
  linkPersonToHouse: vi.fn(async () => ({ id: 'l-new' })),
  searchContacts: vi.fn(async () => []),
  updatePerson: vi.fn(async () => ({ ok: true })),
  updatePersonLink: vi.fn(async () => ({ ok: true })),
  fetchAssignments: vi.fn(async () => []),
  createAssignment: vi.fn(async () => ({ id: 'a-new' })),
  endAssignment: vi.fn(async () => ({ ok: true })),
  createAction: vi.fn(async () => ({ id: 'act-new' })),
  updateAction: vi.fn(async () => ({ ok: true })),
  deleteAction: vi.fn(async () => ({ ok: true })),
  createIssue: vi.fn(async () => ({ id: 'iss-new' })),
  updateIssue: vi.fn(async () => ({ ok: true })),
  createTask: vi.fn(async () => ({ id: 'task-new' })),
  updateTask: vi.fn(async () => ({ ok: true })),
  createEvent: vi.fn(async () => ({ id: 'ev-new' })),
  deleteEvent: vi.fn(async () => ({ ok: true })),
  uploadAttachment: vi.fn(async () => ({ id: 'file-new' })),
  deleteAttachment: vi.fn(async () => ({ ok: true })),
  linkHousePrecinct: vi.fn(async () => ({ id: 'link-new' })),
  unlinkHousePrecinct: vi.fn(async () => ({ ok: true })),
}));

import * as api from '../../../../features/elections/electionsApi.js';

function createHouse(overrides = {}) {
  const { campaign, ...rest } = overrides;

  return {
    id: 'house-1',
    osmType: 'way',
    osmId: 1001,
    street: 'вулиця Зодчих',
    streetShort: 'вул. Зодчих',
    number: '58',
    block: '',
    address: 'вул. Зодчих, 58',
    fullAddress: 'вулиця Зодчих, 58, Київ',
    city: 'Київ',
    postalCode: '03170',
    type: 'apartments',
    building: 'apartments',
    floors: 9,
    builtYear: 1978,
    entrances: 4,
    apartments: 128,
    households: null,
    residentsCount: null,
    managingOrg: '',
    accessNote: '',
    source: 'osm',
    name: null,
    location: { lat: 50.4307636, lon: 30.3640481 },
    footprint: [],
    footprintAreaSqm: 1200,
    estimate: { entrances: 4, apartments: 128, residents: 294 },
    distanceMeters: 120,
    isHeadquarters: false,
    verifiedAt: null,
    verifiedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    precincts: [],
    quality: [],
    canSeeContacts: true,
    contactsCount: 0,
    ...rest,
    campaign: {
      ...createEmptyCampaignState(),
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...(campaign ?? {}),
    },
  };
}

function renderEditor(props = {}) {
  const handlers = {
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onSelectHouse: vi.fn(),
  };

  const utils = render(
    <HouseEditor
      campaign={{ id: 'campaign-1', name: 'Кампанія 2026', status: 'active' }}
      campaignId="campaign-1"
      house={createHouse()}
      knownAssignees={['kovalenko@avku.org']}
      neighbours={['house-0', 'house-1', 'house-2']}
      precincts={[{ id: 'prec-1', number: '123', district: 'Округ 5' }]}
      viewer={{ email: 'coordinator@avku.org', role: 'coordinator' }}
      {...handlers}
      {...props}
    />,
  );

  return { ...utils, handlers };
}

const openSection = (name) => fireEvent.click(screen.getByRole('tab', { name }));

beforeEach(() => {
  vi.clearAllMocks();

  api.saveHouseAttributes.mockImplementation(async (houseId, patch) =>
    createHouse({ ...patch, id: houseId, updatedAt: '2026-06-02T00:00:00.000Z' }),
  );
  api.saveHouseState.mockImplementation(async (houseId, patch) =>
    createHouse({ id: houseId, campaign: { ...patch, updatedAt: '2026-06-02T00:00:00.000Z' } }),
  );
  api.fetchHouse.mockImplementation(async () => createHouse());

  for (const loader of [
    api.fetchHousePeople,
    api.fetchHouseActions,
    api.fetchHouseIssues,
    api.fetchHouseTasks,
    api.fetchHouseEvents,
    api.fetchHouseAttachments,
    api.fetchHouseHistory,
    api.fetchAssignments,
  ]) {
    loader.mockResolvedValue([]);
  }
});

afterEach(cleanup);

describe('the editor surface', () => {
  it('offers exactly the ten sections the module is built around', () => {
    renderEditor();

    const nav = screen.getByRole('tablist', { name: 'Розділи редактора' });
    const labels = within(nav).getAllByRole('tab').map((tab) => tab.textContent.trim());

    expect(labels).toEqual([
      'Основне',
      'Характеристики',
      'Контактні особи',
      'Відповідальні',
      'Дії',
      'Звернення',
      'Завдання',
      'Події',
      'Файли',
      'Історія',
    ]);
  });

  it('puts the address, the campaign and the save controls in the header', () => {
    renderEditor();

    const header = within(document.querySelector('header'));

    expect(header.getByText('вул. Зодчих, 58')).toBeTruthy();
    expect(header.getByText(/Кампанія 2026/)).toBeTruthy();
    expect(header.getAllByRole('button', { name: /Зберегти/ }).length).toBeGreaterThan(0);
    expect(header.getByRole('button', { name: 'Скасувати' })).toBeTruthy();
    expect(header.getByRole('button', { name: 'Закрити редактор' })).toBeTruthy();
  });

  /*
   * Opening a house must not download its whole file. A building worked for a
   * year carries hundreds of actions, a journal and every uploaded photo, and
   * «Основне» needs none of it.
   */
  it('loads a section only when it is opened', async () => {
    renderEditor();

    expect(api.fetchHouseActions).not.toHaveBeenCalled();
    expect(api.fetchHouseHistory).not.toHaveBeenCalled();

    openSection('Дії');

    await waitFor(() =>
      expect(api.fetchHouseActions).toHaveBeenCalledWith(
        'house-1',
        expect.objectContaining({ campaignId: 'campaign-1' }),
      ),
    );

    expect(api.fetchHouseHistory).not.toHaveBeenCalled();
  });

  it('keeps a typed value when moving between sections', () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Обійшли 1–3 підʼїзд' },
    });

    openSection('Файли');
    openSection('Основне');

    expect(screen.getByLabelText(/Коротке резюме/).value).toBe('Обійшли 1–3 підʼїзд');
  });
});

describe('saving the house and the campaign state', () => {
  /**
   * The split is the point of the whole model: a building's entrance count and
   * a campaign's stage have different lifetimes and different permissions, and
   * a single form that posted both to one endpoint would put last year's
   * results in this year's record.
   */
  it('sends the permanent record and the campaign state to different endpoints', async () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Домовились на суботу' },
    });

    openSection('Характеристики');
    fireEvent.change(screen.getByLabelText(/Підʼїздів/), { target: { value: '6' } });

    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    await waitFor(() => expect(api.saveHouseAttributes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.saveHouseState).toHaveBeenCalledTimes(1));

    const [, attributes] = api.saveHouseAttributes.mock.calls[0];
    const [, state] = api.saveHouseState.mock.calls[0];

    expect(attributes.entrances).toBe(6);
    expect(attributes).not.toHaveProperty('stage');
    expect(attributes).not.toHaveProperty('summary');

    expect(state.summary).toBe('Домовились на суботу');
    expect(state).not.toHaveProperty('entrances');
  });

  it('touches only the half that changed', async () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText(/Причина пріоритету/), {
      target: { value: 'Багато звернень' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    await waitFor(() => expect(api.saveHouseState).toHaveBeenCalledTimes(1));

    expect(api.saveHouseAttributes).not.toHaveBeenCalled();
  });

  it('saves the block and the data source, which the old form had nowhere to put', async () => {
    renderEditor();

    openSection('Характеристики');
    fireEvent.change(screen.getByLabelText(/Корпус/), { target: { value: 'корпус 2' } });
    fireEvent.change(screen.getByLabelText(/Джерело даних/), {
      target: { value: 'обхід 12.05' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    await waitFor(() => expect(api.saveHouseAttributes).toHaveBeenCalledTimes(1));

    expect(api.saveHouseAttributes.mock.calls[0][1]).toMatchObject({
      block: 'корпус 2',
      source: 'обхід 12.05',
    });
  });

  /* The author of a check is the server's answer, never the client's. */
  it('never sends an author or a check date', async () => {
    renderEditor();

    openSection('Характеристики');
    fireEvent.click(screen.getByLabelText(/Я перевірив/));
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    await waitFor(() => expect(api.saveHouseAttributes).toHaveBeenCalledTimes(1));

    const [, payload] = api.saveHouseAttributes.mock.calls[0];

    expect(payload.verified).toBe(true);
    expect(payload).not.toHaveProperty('verifiedBy');
    expect(payload).not.toHaveProperty('verifiedAt');
    expect(payload).not.toHaveProperty('updatedBy');
  });

  it('carries the loaded updatedAt so the server can refuse a stale write', async () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Оновлено' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    await waitFor(() => expect(api.saveHouseState).toHaveBeenCalledTimes(1));

    expect(api.saveHouseState.mock.calls[0][1].expectedUpdatedAt).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('offers a choice — not a silent overwrite — when the record has moved on', async () => {
    const conflict = Object.assign(new Error('Запис змінив інший користувач.'), {
      status: 409,
    });

    api.saveHouseState.mockRejectedValueOnce(conflict);
    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Мої зміни' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    expect(await screen.findByText('Запис змінив інший користувач')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Оновити дані' })).toBeTruthy();

    // The typed value survives the conflict.
    expect(screen.getByLabelText(/Коротке резюме/).value).toBe('Мої зміни');

    fireEvent.click(screen.getByRole('button', { name: 'Зберегти мою версію' }));

    await waitFor(() => expect(api.saveHouseState).toHaveBeenCalledTimes(2));

    // A forced save drops the token deliberately, having asked first.
    expect(api.saveHouseState.mock.calls[1][1].expectedUpdatedAt).toBeUndefined();
  });
});

describe('a save the server refuses', () => {
  it('keeps every typed value and shows the server’s own message', async () => {
    api.saveHouseAttributes.mockRejectedValueOnce(
      new Error('Недостатньо прав: потрібна роль «coordinator» або вища.'),
    );

    renderEditor();

    openSection('Характеристики');
    fireEvent.change(screen.getByLabelText(/Керуюча організація/), {
      target: { value: 'ОСББ «Зодчих 58»' },
    });
    fireEvent.change(screen.getByLabelText(/Заселених квартир/), {
      target: { value: '96' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    expect(await screen.findByText(/Недостатньо прав/)).toBeTruthy();

    expect(screen.getByLabelText(/Керуюча організація/).value).toBe('ОСББ «Зодчих 58»');
    expect(screen.getByLabelText(/Заселених квартир/).value).toBe('96');
  });

  it('does not announce success before the server has answered', async () => {
    let resolveSave;

    api.saveHouseState.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'У процесі' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Зберегти/ })[0]);

    await screen.findAllByText('Зберігаємо…');
    expect(screen.queryByText('Зміни збережено.')).toBeNull();

    resolveSave(createHouse({ campaign: { summary: 'У процесі' } }));

    expect(await screen.findByText('Зміни збережено.')).toBeTruthy();
  });

  /** A double tap must not produce two records — or two requests. */
  it('runs one request however many times the button is pressed', async () => {
    let resolveSave;

    api.saveHouseState.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Один раз' },
    });

    const saveButton = screen.getAllByRole('button', { name: /Зберегти/ })[0];

    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    await waitFor(() => expect(api.saveHouseState).toHaveBeenCalledTimes(1));

    resolveSave(createHouse());
  });
});

describe('unsaved changes', () => {
  it('asks before closing and can be called back', () => {
    const { handlers } = renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Не збережено' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Закрити редактор' }));

    const dialog = within(screen.getByRole('alertdialog'));

    expect(dialog.getByText('Є незбережені зміни')).toBeTruthy();
    expect(handlers.onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Повернутись до редагування' }));

    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Коротке резюме/).value).toBe('Не збережено');
  });

  it('closes without asking when nothing was changed', () => {
    const { handlers } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Закрити редактор' }));

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before switching to another house', () => {
    const { handlers } = renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Наполовину заповнено' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Наступний будинок' }));

    expect(handlers.onSelectHouse).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole('alertdialog')).getByText('Є незбережені зміни'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Вийти без збереження' }));

    expect(handlers.onSelectHouse).toHaveBeenCalledWith('house-2');
  });

  it('«Скасувати» puts the draft back rather than writing anything', () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Передумав' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));

    expect(screen.getByLabelText(/Коротке резюме/).value).toBe('');
    expect(api.saveHouseState).not.toHaveBeenCalled();
  });
});

describe('independent records save themselves', () => {
  it('creates a task once, with its own fields', async () => {
    renderEditor();

    openSection('Завдання');

    fireEvent.click(await screen.findByRole('button', { name: /Нова задача/ }));
    fireEvent.change(screen.getByLabelText(/Що зробити/), {
      target: { value: 'Передзвонити голові ОСББ' },
    });

    const submit = screen.getByRole('button', { name: /Створити задачу/ });

    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));

    expect(api.createTask.mock.calls[0][0]).toMatchObject({
      title: 'Передзвонити голові ОСББ',
      houseId: 'house-1',
    });
  });

  it('creates an issue with the full record, not one note field', async () => {
    renderEditor();

    openSection('Звернення');

    fireEvent.click(await screen.findByRole('button', { name: /Нове звернення/ }));
    fireEvent.change(screen.getByLabelText(/Назва звернення/), {
      target: { value: 'Не працює освітлення' },
    });
    fireEvent.change(screen.getByLabelText(/^Категорія/), { target: { value: 'lighting' } });
    fireEvent.change(screen.getByLabelText(/^Опис/), {
      target: { value: 'Третій підʼїзд, з боку двору' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Створити звернення/ }));

    await waitFor(() => expect(api.createIssue).toHaveBeenCalledTimes(1));

    expect(api.createIssue.mock.calls[0][0]).toMatchObject({
      title: 'Не працює освітлення',
      category: 'lighting',
      description: 'Третій підʼїзд, з боку двору',
      houseId: 'house-1',
    });
  });

  it('checks for a duplicate before creating a contact', async () => {
    api.searchContacts.mockResolvedValue([
      {
        personId: 'p-existing',
        fullName: 'Коваленко Олена',
        role: 'osbb_head',
        houseId: 'house-9',
        houseAddress: 'вул. Зодчих, 60',
        matchedOn: 'name',
      },
    ]);

    renderEditor();
    openSection('Контактні особи');

    fireEvent.click(await screen.findByRole('button', { name: /Додати контакт/ }));
    fireEvent.change(screen.getByLabelText(/Імʼя/), {
      target: { value: 'Коваленко Олена' },
    });

    expect(await screen.findByText('Схожі контакти вже є')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Це та сама особа' }));

    await waitFor(() => expect(api.linkPersonToHouse).toHaveBeenCalledTimes(1));
    expect(api.createHousePerson).not.toHaveBeenCalled();
  });
});

describe('permissions', () => {
  it('an archived campaign is readable and not writable', () => {
    renderEditor({
      campaign: { id: 'campaign-1', name: 'Кампанія 2024', status: 'archived' },
    });

    expect(screen.getByText(/Кампанію заархівовано/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Спроба' },
    });

    for (const button of screen.getAllByRole('button', { name: /Зберегти/ })) {
      expect(button.disabled).toBe(true);
    }
  });

  it('a viewer with no role sees the record and no way to change it', () => {
    renderEditor({ viewer: { email: 'guest@avku.org', role: null } });

    expect(screen.getByText(/потрібна роль/i)).toBeTruthy();
    expect(screen.getByLabelText(/Коротке резюме/).disabled).toBe(true);
  });

  /*
   * An agitator records field work but does not edit the building — the API
   * requires a coordinator for `PATCH /houses/:id`, and the form says so
   * instead of collecting values the server will refuse.
   */
  it('an agitator may set the stage but not the entrance count', () => {
    renderEditor({ viewer: { email: 'agitator@avku.org', role: 'agitator' } });

    expect(screen.getByLabelText(/Етап роботи/).disabled).toBe(false);

    openSection('Характеристики');
    expect(screen.getByLabelText(/Підʼїздів/).disabled).toBe(true);
  });

  it('only a manager is offered the contact deletion', async () => {
    api.fetchHousePeople.mockResolvedValue([
      {
        id: 'p1',
        fullName: 'Коваленко Олена',
        role: 'osbb_head',
        note: '',
        isMasked: false,
        links: [{ id: 'l1', houseId: 'house-1', entrance: '2', apartment: '12' }],
        contacts: [],
      },
    ]);

    renderEditor();
    openSection('Контактні особи');

    expect(await screen.findByText('Коваленко Олена')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Видалити контакт' })).toBeNull();
    expect(screen.getByRole('button', { name: /Відвʼязати від будинку/ })).toBeTruthy();
  });
});

describe('switching house', () => {
  /**
   * Clicking down a street otherwise leaves a queue of responses arriving in
   * whatever order the network chose, and the last to land wins — which is not
   * the same as the last one asked for.
   */
  it('never shows the previous house’s records', async () => {
    api.fetchHouseActions.mockResolvedValueOnce([
      {
        id: 'act-old',
        type: 'visit',
        result: 'contacted',
        happenedAt: '2026-05-01T10:00:00.000Z',
        comment: 'Запис старого будинку',
        nextStep: '',
        authorEmail: 'a@avku.org',
      },
    ]);

    const { rerender } = renderEditor();

    openSection('Дії');
    expect(await screen.findByText('Запис старого будинку')).toBeTruthy();

    api.fetchHouseActions.mockResolvedValueOnce([]);

    rerender(
      <HouseEditor
        campaign={{ id: 'campaign-1', name: 'Кампанія 2026', status: 'active' }}
        campaignId="campaign-1"
        house={createHouse({ id: 'house-2', address: 'вул. Зодчих, 60' })}
        knownAssignees={[]}
        neighbours={['house-1', 'house-2']}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSelectHouse={vi.fn()}
        precincts={[]}
        viewer={{ email: 'coordinator@avku.org', role: 'coordinator' }}
      />,
    );

    await waitFor(() => expect(screen.queryByText('Запис старого будинку')).toBeNull());
    expect(screen.getByText('вул. Зодчих, 60')).toBeTruthy();
  });

  it('rebuilds the draft from the house that is now open', () => {
    const { rerender } = renderEditor();

    fireEvent.change(screen.getByLabelText(/Коротке резюме/), {
      target: { value: 'Перший будинок' },
    });

    rerender(
      <HouseEditor
        campaign={{ id: 'campaign-1', name: 'Кампанія 2026', status: 'active' }}
        campaignId="campaign-1"
        house={createHouse({
          id: 'house-2',
          address: 'вул. Зодчих, 60',
          campaign: { summary: 'Другий будинок' },
        })}
        knownAssignees={[]}
        neighbours={['house-1', 'house-2']}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSelectHouse={vi.fn()}
        precincts={[]}
        viewer={{ email: 'coordinator@avku.org', role: 'coordinator' }}
      />,
    );

    expect(screen.getByLabelText(/Коротке резюме/).value).toBe('Другий будинок');
  });
});

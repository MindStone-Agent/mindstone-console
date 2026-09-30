/**
 * MindStone agents in the model menu (#53): each is listed as
 * mindstone/<agentId>; the menu, the selected label and search use the
 * agent's name, and selection still uses the id.
 */
import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, filterModels, getDisplayValue, modelDisplayName } from '../utils';

const mindstone: Endpoint = {
  value: 'MindStone',
  label: 'MindStone',
  hasModels: true,
  icon: null,
  models: [{ name: 'mindstone/default' }, { name: 'mindstone/analyst' }],
  modelNames: { 'mindstone/default': 'Cairn', 'mindstone/analyst': 'Threat Analyst' },
};
const localize = ((key: string) => key) as ReturnType<typeof useLocalize>;

describe('MindStone agent names in the model menu (#53)', () => {
  it('shows the name, and the id when there is no name', () => {
    expect(modelDisplayName(mindstone, 'mindstone/default')).toBe('Cairn');
    expect(modelDisplayName(mindstone, 'mindstone/other')).toBe('mindstone/other');
    expect(modelDisplayName(undefined, 'mindstone/default')).toBe('mindstone/default');
  });

  it('shows the selected agent by name', () => {
    expect(
      getDisplayValue({
        localize,
        mappedEndpoints: [mindstone],
        modelSpecs: [],
        selectedValues: { endpoint: 'MindStone', model: 'mindstone/analyst', modelSpec: null },
      }),
    ).toBe('Threat Analyst');
  });

  it('finds the endpoint and the agent by name, and still by id', () => {
    expect(filterItems([mindstone], 'cairn', undefined, undefined)).toEqual([mindstone]);
    expect(filterItems([mindstone], 'nobody', undefined, undefined)).toEqual([]);
    const ids = mindstone.models!.map((m) => m.name);
    expect(filterModels(mindstone, ids, 'threat', undefined, undefined)).toEqual([
      'mindstone/analyst',
    ]);
    expect(filterModels(mindstone, ids, 'mindstone/def', undefined, undefined)).toEqual([
      'mindstone/default',
    ]);
  });
});

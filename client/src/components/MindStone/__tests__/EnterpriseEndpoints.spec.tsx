/**
 * Enterprise model endpoints (MindStone-Agent #126): the form built from the
 * gateway's field list, the Providers page (list, Test, remove) and the
 * enterprise choice in guided setup. Keys go to the secrets endpoint first;
 * the registration only ever names them.
 */
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EnterpriseKind } from '../EnterpriseEndpointForm';
import { missingFields, registrationPlan } from '../EnterpriseEndpointForm';
import MindStoneOnboardingView from '../OnboardingView';
import MindStoneProvidersView from '../ProvidersView';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();
jest.mock('librechat-data-provider', () => ({
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));
jest.mock('~/hooks', () => {
  // One function, as the real hook keeps it.
  const localize = (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key;
  return { useLocalize: () => localize };
});

const BASE = '/api/mindstone/admin';
const AZURE: EnterpriseKind = {
  kind: 'azure-openai',
  providerId: 'enterprise-azure',
  name: 'Azure OpenAI / AI Foundry',
  listsModels: false,
  fields: [
    { name: 'endpoint', label: 'Endpoint', type: 'url', required: true },
    { name: 'models', label: 'Deployment names', type: 'list', required: true },
    { name: 'apiVersion', label: 'API version', type: 'text', required: false },
    { name: 'secret', label: 'API key', type: 'secret', required: true },
  ],
};
const BEDROCK: EnterpriseKind = {
  kind: 'bedrock',
  providerId: 'enterprise-bedrock',
  name: 'Amazon Bedrock',
  listsModels: false,
  fields: [
    { name: 'region', label: 'Region', type: 'text', required: true },
    { name: 'models', label: 'Model ids', type: 'list', required: true },
    {
      name: 'accessKeyIdSecret',
      label: 'Access key id',
      type: 'secret',
      required: 'one-of',
      group: 'keys',
    },
    {
      name: 'secretAccessKeySecret',
      label: 'Secret access key',
      type: 'secret',
      required: 'one-of',
      group: 'keys',
    },
    {
      name: 'sessionTokenSecret',
      label: 'Session token (optional)',
      type: 'secret',
      required: false,
    },
    {
      name: 'bearerTokenSecret',
      label: 'Bedrock API key',
      type: 'secret',
      required: 'one-of',
      group: 'bearer',
    },
  ],
};
const GATEWAY: EnterpriseKind = {
  kind: 'enterprise-openai',
  providerId: 'enterprise-openai',
  name: 'OpenAI-compatible enterprise gateway',
  listsModels: true,
  fields: [
    { name: 'baseUrl', label: 'Base URL', type: 'url', required: true },
    { name: 'secret', label: 'API key', type: 'secret', required: true },
    { name: 'headers', label: 'Extra headers', type: 'headers', required: false },
    { name: 'models', label: 'Model ids', type: 'list', required: false },
  ],
};

let advancedSettings: boolean;
let registered: Array<Record<string, unknown>>;

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockDelete.mockReset();
  advancedSettings = true;
  registered = [
    {
      providerId: 'ollama',
      name: 'Ollama (local)',
      baseUrl: 'http://localhost:11434/v1',
      modelCount: 2,
      auth: 'stored key',
    },
    {
      providerId: 'enterprise-azure',
      name: 'Azure OpenAI / AI Foundry',
      baseUrl: 'https://res.openai.azure.com',
      modelCount: 1,
      auth: 'stored credentials',
      kind: 'azure-openai',
    },
  ];
  mockGet.mockImplementation(async (url: string) => {
    if (url === `${BASE}/permissions`) return { permissions: { advancedSettings } };
    if (url === `${BASE}/models`) {
      return {
        presets: [],
        providers: [],
        models: [],
        registered,
        enterprise: [AZURE, BEDROCK, GATEWAY],
      };
    }
    if (url === `${BASE}/status`) return { ok: true, onboarded: false, profiles: [], steps: {} };
    if (url === `${BASE}/config`) return { config: {}, etag: '"e1"' };
    throw new Error(`unexpected GET ${url}`);
  });
});

function renderProviders() {
  render(
    <MemoryRouter initialEntries={['/mindstone/providers']}>
      <Routes>
        <Route path="/mindstone/providers" element={<MindStoneProvidersView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('registrationPlan', () => {
  it('names each key as a stored secret and never puts a value in the body', () => {
    const plan = registrationPlan(
      AZURE,
      {
        endpoint: ' https://res.openai.azure.com ',
        models: 'gpt-4o,\n gpt-4o-mini',
        secret: ' KEY with spaces ',
      },
      undefined,
      [],
    );
    expect(plan.body).toEqual({
      endpoint: 'https://res.openai.azure.com',
      models: ['gpt-4o', 'gpt-4o-mini'],
      secret: 'enterprise-azure.secret',
    });
    // A key keeps its exact characters.
    expect(plan.secrets).toEqual([{ name: 'enterprise-azure.secret', value: ' KEY with spaces ' }]);
    expect(JSON.stringify(plan.body)).not.toContain('KEY');
  });

  it('sends only the chosen credential group', () => {
    const values = {
      region: 'us-east-1',
      models: 'm',
      accessKeyIdSecret: 'AKIA',
      secretAccessKeySecret: 'SECRET',
      bearerTokenSecret: 'BEARER',
    };
    const keys = registrationPlan(BEDROCK, values, 'keys', []);
    expect(Object.keys(keys.body).sort()).toEqual([
      'accessKeyIdSecret',
      'models',
      'region',
      'secretAccessKeySecret',
    ]);
    expect(keys.secrets.map((s) => s.value)).not.toContain('BEARER');
    const bearer = registrationPlan(BEDROCK, values, 'bearer', []);
    expect(Object.keys(bearer.body).sort()).toEqual(['bearerTokenSecret', 'models', 'region']);
    expect(bearer.secrets.map((s) => s.value)).toEqual(['BEARER']);
  });

  it('stores a secret header and sends a plain one as text', () => {
    const plan = registrationPlan(
      GATEWAY,
      { baseUrl: 'https://llm.example.com/v1', secret: 'K' },
      undefined,
      [
        { name: 'Ocp-Apim-Subscription-Key', value: 'SUB', secret: true },
        { name: 'X-Team', value: 'blue', secret: false },
        { name: '  ', value: 'ignored', secret: false },
      ],
    );
    expect(plan.body.headers).toEqual({
      'Ocp-Apim-Subscription-Key': { secret: 'enterprise-openai.header-ocp-apim-subscription-key' },
      'X-Team': 'blue',
    });
    expect(plan.secrets).toContainEqual({
      name: 'enterprise-openai.header-ocp-apim-subscription-key',
      value: 'SUB',
    });
    // No models typed: the gateway lists them.
    expect(plan.body).not.toHaveProperty('models');
  });

  it('asks for the chosen group, not the other one', () => {
    expect(missingFields(BEDROCK, { region: 'r', models: 'm' }, 'bearer')).toEqual([
      'Bedrock API key',
    ]);
    expect(missingFields(BEDROCK, { region: 'r', models: 'm' }, 'keys')).toEqual([
      'Access key id',
      'Secret access key',
    ]);
    expect(missingFields(GATEWAY, { baseUrl: 'u', secret: 'k' }, undefined)).toEqual([]);
  });
});

describe('the Providers page', () => {
  it('registers an endpoint: secrets first, then the provider by secret name; the typed key is cleared', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/providers/enterprise/azure-openai`) {
        return {
          ok: true,
          providerId: 'enterprise-azure',
          host: 'res.openai.azure.com',
          models: ['enterprise-azure/gpt-4o'],
        };
      }
      return { ok: true };
    });
    renderProviders();
    fireEvent.click(await screen.findByRole('radio', { name: 'Azure OpenAI / AI Foundry' }));
    const form = screen.getByTestId('ms-ent-form-azure-openai');
    const save = within(form).getByRole('button', { name: 'com_mindstone_ent_register' });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Endpoint'), {
      target: { value: 'https://res.openai.azure.com' },
    });
    fireEvent.change(within(form).getByLabelText('Deployment names'), {
      target: { value: 'gpt-4o' },
    });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'AZ-KEY-1' } });
    expect(within(form).getByLabelText('API key')).toHaveAttribute('type', 'password');
    fireEvent.click(save);
    await screen.findByText(/com_mindstone_ent_registered enterprise-azure 1 res.openai.azure.com/);
    const urls = mockPost.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      `${BASE}/secrets/enterprise-azure.secret`,
      `${BASE}/providers/enterprise/azure-openai`,
    ]);
    expect(mockPost.mock.calls[0][1]).toEqual({ value: 'AZ-KEY-1' });
    expect(mockPost.mock.calls[1][1]).toEqual({
      endpoint: 'https://res.openai.azure.com',
      models: ['gpt-4o'],
      secret: 'enterprise-azure.secret',
    });
    expect(JSON.stringify(mockPost.mock.calls[1][1])).not.toContain('AZ-KEY-1');
  });

  it("shows the gateway's refusal and registers nothing more", async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.startsWith(`${BASE}/providers/enterprise/`)) {
        throw {
          response: { status: 400, data: { ok: false, error: 'endpoint must be a public host' } },
        };
      }
      return { ok: true };
    });
    renderProviders();
    fireEvent.click(await screen.findByRole('radio', { name: 'Azure OpenAI / AI Foundry' }));
    const form = screen.getByTestId('ms-ent-form-azure-openai');
    fireEvent.change(within(form).getByLabelText('Endpoint'), {
      target: { value: 'https://10.0.0.1' },
    });
    fireEvent.change(within(form).getByLabelText('Deployment names'), {
      target: { value: 'gpt-4o' },
    });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'K' } });
    fireEvent.click(within(form).getByRole('button', { name: 'com_mindstone_ent_register' }));
    expect(await screen.findByRole('status')).toHaveTextContent('endpoint must be a public host');
  });

  it('switches Bedrock between access keys and an API key', async () => {
    renderProviders();
    fireEvent.click(await screen.findByRole('radio', { name: 'Amazon Bedrock' }));
    const form = screen.getByTestId('ms-ent-form-bedrock');
    // The key fields, not the radios that choose between them.
    const key = { selector: 'input[type=password]' };
    expect(within(form).getByLabelText('Access key id', key)).toBeInTheDocument();
    expect(within(form).queryByLabelText('Bedrock API key', key)).toBeNull();
    fireEvent.click(within(form).getByRole('radio', { name: 'Bedrock API key' }));
    expect(within(form).getByLabelText('Bedrock API key', key)).toBeInTheDocument();
    expect(within(form).queryByLabelText('Access key id', key)).toBeNull();
  });

  it('tests a provider and shows what it answered, or why not, with hidden characters shown', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/providers/ollama/test`) {
        return {
          ok: true,
          providerId: 'ollama',
          model: 'ollama/llama3',
          latencyMs: 812,
          reply: 'ready',
        };
      }
      if (url === `${BASE}/providers/enterprise-azure/test`) {
        return {
          ok: false,
          providerId: 'enterprise-azure',
          model: 'enterprise-azure/gpt-4o',
          error: '401 bad key‮',
        };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderProviders();
    const ollama = await screen.findByTestId('ms-provider-ollama');
    fireEvent.click(within(ollama).getByRole('button', { name: 'com_mindstone_ent_test' }));
    expect(await within(ollama).findByTestId('ms-ent-test-result')).toHaveTextContent(
      'com_mindstone_ent_test_ok ollama/llama3 812 ready',
    );
    const azure = screen.getByTestId('ms-provider-enterprise-azure');
    fireEvent.click(within(azure).getByRole('button', { name: 'com_mindstone_ent_test' }));
    expect(await within(azure).findByTestId('ms-ent-test-result')).toHaveTextContent(
      'com_mindstone_ent_test_failed enterprise-azure/gpt-4o 401 bad key\\u{202E}',
    );
    expect(mockPost).toHaveBeenCalledWith(`${BASE}/providers/enterprise-azure/test`, {});
  });

  it('removes only an enterprise provider, after a confirmation', async () => {
    mockDelete.mockResolvedValue({ ok: true, providerId: 'enterprise-azure', removed: true });
    renderProviders();
    const ollama = await screen.findByTestId('ms-provider-ollama');
    expect(within(ollama).queryByRole('button', { name: 'com_mindstone_prov_remove' })).toBeNull();
    const azure = screen.getByTestId('ms-provider-enterprise-azure');
    fireEvent.click(within(azure).getByRole('button', { name: 'com_mindstone_prov_remove' }));
    expect(mockDelete).not.toHaveBeenCalled();
    registered = registered.filter((p) => p.providerId !== 'enterprise-azure');
    fireEvent.click(
      within(azure).getByRole('button', { name: 'com_mindstone_prov_confirm_remove' }),
    );
    await screen.findByText('com_mindstone_prov_removed enterprise-azure');
    expect(mockDelete).toHaveBeenCalledWith(`${BASE}/providers/enterprise-azure`);
    await waitFor(() => expect(screen.queryByTestId('ms-provider-enterprise-azure')).toBeNull());
  });

  it('without advanced settings, nothing can be tested, removed or saved', async () => {
    advancedSettings = false;
    renderProviders();
    const azure = await screen.findByTestId('ms-provider-enterprise-azure');
    await screen.findByText('com_mindstone_prov_need_advanced');
    expect(within(azure).getByRole('button', { name: 'com_mindstone_ent_test' })).toBeDisabled();
    expect(within(azure).getByRole('button', { name: 'com_mindstone_prov_remove' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'OpenAI-compatible enterprise gateway' }));
    const form = screen.getByTestId('ms-ent-form-enterprise-openai');
    fireEvent.change(within(form).getByLabelText('Base URL'), {
      target: { value: 'https://llm.example.com/v1' },
    });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'K' } });
    expect(within(form).getByRole('button', { name: 'com_mindstone_ent_register' })).toBeDisabled();
  });
});

describe('guided setup', () => {
  it('offers the enterprise kinds, registers one, tests its own model and continues to the model step', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/providers/enterprise/azure-openai`) {
        return {
          ok: true,
          providerId: 'enterprise-azure',
          host: 'res.openai.azure.com',
          models: ['enterprise-azure/gpt-4o'],
        };
      }
      if (url === `${BASE}/providers/enterprise-azure/test`) {
        return { ok: true, model: 'enterprise-azure/gpt-4o', latencyMs: 400, reply: 'ready' };
      }
      return { ok: true };
    });
    render(
      <MemoryRouter initialEntries={['/mindstone/onboarding']}>
        <Routes>
          <Route path="/mindstone/onboarding" element={<MindStoneOnboardingView />} />
        </Routes>
      </MemoryRouter>,
    );
    // Access is on already: on to the provider step.
    fireEvent.click(await screen.findByRole('button', { name: 'com_mindstone_onb_next' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Azure OpenAI / AI Foundry' }));
    const form = screen.getByTestId('ms-ent-form-azure-openai');
    fireEvent.change(within(form).getByLabelText('Endpoint'), {
      target: { value: 'https://res.openai.azure.com' },
    });
    fireEvent.change(within(form).getByLabelText('Deployment names'), {
      target: { value: 'gpt-4o' },
    });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'AZ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'com_mindstone_ent_register' }));
    const done = await screen.findByTestId('ms-onb-enterprise-done');
    fireEvent.click(within(done).getByRole('button', { name: 'com_mindstone_ent_test' }));
    expect(await within(done).findByTestId('ms-ent-test-result')).toHaveTextContent('ready');
    // The model just registered is the one tested.
    expect(mockPost).toHaveBeenCalledWith(`${BASE}/providers/enterprise-azure/test`, {
      model: 'enterprise-azure/gpt-4o',
    });
    fireEvent.click(within(done).getByRole('button', { name: 'com_mindstone_onb_save_next' }));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' }),
    ).toBeInTheDocument();
  });
});

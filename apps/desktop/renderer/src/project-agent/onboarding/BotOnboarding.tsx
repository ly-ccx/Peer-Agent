import type { I18nRuntime } from '@peer-agent/i18n';
import type { OnboardingStep } from './botShell';

export function BotOnboarding({
  step,
  i18n,
  onConnect,
  onCreate,
}: {
  readonly step: OnboardingStep;
  readonly i18n: I18nRuntime;
  readonly onConnect: () => void;
  readonly onCreate: () => void;
}) {
  const connect = step === 'connect-model';
  return (
    <div className="bot-main-empty bot-onboarding">
      <h1>{i18n.t(connect ? 'projectAgent.onboarding.connectTitle' : 'projectAgent.onboarding.createTitle')}</h1>
      <p>{i18n.t(connect ? 'projectAgent.onboarding.connectBody' : 'projectAgent.onboarding.createBody')}</p>
      <button
        type="button"
        className="bot-onboarding-action"
        onClick={connect ? onConnect : onCreate}
      >
        {i18n.t(connect ? 'projectAgent.onboarding.connectAction' : 'projectAgent.onboarding.createAction')}
      </button>
    </div>
  );
}

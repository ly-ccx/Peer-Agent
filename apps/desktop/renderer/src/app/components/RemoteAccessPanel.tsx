import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { BotAvatar } from '../../project-agent/BotAvatar';
import { Checkbox } from '../../ui/boolean-controls/Checkbox';
import { Switch } from '../../ui/boolean-controls/Switch';
import { connectionSummary, describeFailure } from './remoteAccessPresentation';
import { changeProjectGrant, createRemoteAccessPanelState } from './remoteAccessPanelState';
import { RemoteAccessPairing } from './RemoteAccessPairing';
import './remote-access.css';

export function RemoteAccessPanel({ i18n }: { i18n: I18nRuntime }) {
  const state = useMemo(() => createRemoteAccessPanelState(clientApi), []);
  const { status, bots, error, listFailed, busy } = useSyncExternalStore(state.subscribe, state.getSnapshot);
  const [gateway, setGateway] = useState('');
  useEffect(() => {
    state.start();
    const timer = setInterval(() => { void state.refresh(); }, 3000);
    return () => { clearInterval(timer); state.stop(); };
  }, [state]);
  useEffect(() => { if (status) setGateway(status.settings.gatewayOrigin); }, [status?.settings.gatewayOrigin]);
  const t = i18n.t;
  const settings = status?.settings;
  const access = status?.lastAccess;
  const accessedBot = bots.find(bot => bot.workspaceId === access?.workspaceId);

  return <section className="remote-access-panel" aria-labelledby="remote-access-title">
    <header><h2 id="remote-access-title">{t('remoteAccess.title')}</h2><p>{t('remoteAccess.description')}</p></header>
    {error && <p className="remote-access-error" role="alert">{t('remoteAccess.error', { reason: error })}</p>}
    {!status || !settings ? <p role="status">{t('remoteAccess.loading')}</p> : <>
      <section className="remote-access-card">
        <div className="remote-access-enable">
          <div><h3 id="remote-access-enable">{t('remoteAccess.enable')}</h3><p>{t('remoteAccess.enableHint')}</p></div>
          <Switch aria-labelledby="remote-access-enable" checked={settings.enabled} disabled={busy || !settings.gatewayOrigin}
            onCheckedChange={enabled => { void state.update({ enabled, projectGrants: settings.projectGrants }); }} />
        </div>
        <form className="remote-access-gateway" onSubmit={event => { event.preventDefault(); void state.update({ gatewayOrigin: gateway.trim() }); }}>
          <label htmlFor="remote-gateway">{t('remoteAccess.gateway')}</label>
          <div><input id="remote-gateway" value={gateway} onChange={event => setGateway(event.target.value)}
            placeholder="https://gateway.example.com" disabled={busy} autoComplete="off" spellCheck={false} />
            <button type="submit" disabled={busy || !gateway.trim() || gateway.trim() === settings.gatewayOrigin}>{t('remoteAccess.gatewaySave')}</button></div>
          <p>{t('remoteAccess.gatewayHint')}</p>
        </form>
        <div className="remote-access-connection"><span>{t('remoteAccess.status')}</span>
          <strong data-online={status.online}>{connectionSummary(status, i18n)}</strong>
          {settings.enabled && <button type="button" disabled={busy} onClick={() => { void state.reconnect(); }}>{t('remoteAccess.retry')}</button>}
        </div>
        {!status.online && status.lastFailure && <p className="remote-access-error">{describeFailure(status.lastFailure, i18n)}</p>}
        {settings.gatewayOrigin && <div className="remote-access-links">
          <a href={`${settings.gatewayOrigin}/devices`} target="_blank" rel="noreferrer">{t('remoteAccess.openDevices')}</a>
          <a href={`${settings.gatewayOrigin}/bots`} target="_blank" rel="noreferrer">{t('remoteAccess.openBots')}</a>
        </div>}
      </section>
      {status.pairing && <RemoteAccessPairing pairing={status.pairing} i18n={i18n} />}
      <section className="remote-access-card">
        <div className="remote-access-section-title"><h3>{t('remoteAccess.grants')}</h3><span>{t('remoteAccess.version', { version: settings.delegationVersion })}</span></div>
        <p>{t('remoteAccess.grantsHint')}</p>
        {listFailed ? <p role="alert">{t('remoteAccess.listFailed')}</p> : !bots.length ? <p>{t('remoteAccess.empty')}</p> :
          <table className="remote-access-grants"><thead><tr><th scope="col">{t('remoteAccess.bot')}</th><th scope="col">{t('remoteAccess.read')}</th><th scope="col">{t('remoteAccess.message')}</th></tr></thead>
            <tbody>{bots.map(bot => {
              const grant = settings.projectGrants.find(row => row.workspaceId === bot.workspaceId);
              const name = bot.profile.displayName;
              return <tr key={bot.workspaceId}><th scope="row"><div className="remote-access-bot"><BotAvatar avatar={bot.profile.avatar} label={name} workspaceId={bot.workspaceId} /><span>{name}</span></div></th>
                <td><label className="remote-access-checkbox"><Checkbox aria-label={t('remoteAccess.readLabel', { name })} checked={grant?.allowProjectRead ?? false} disabled={busy}
                  onChange={event => { void state.update({ projectGrants: changeProjectGrant(settings.projectGrants, bot.workspaceId, 'read', event.target.checked) }); }} /></label></td>
                <td><label className="remote-access-checkbox"><Checkbox aria-label={t('remoteAccess.messageLabel', { name })} checked={grant?.allowProjectMessage ?? false} disabled={busy || !grant?.allowProjectRead}
                  onChange={event => { void state.update({ projectGrants: changeProjectGrant(settings.projectGrants, bot.workspaceId, 'message', event.target.checked) }); }} /></label></td>
              </tr>;
            })}</tbody></table>}
      </section>
      <section className="remote-access-card remote-access-activity"><h3>{t('remoteAccess.lastAccess')}</h3>
        {access ? <div><span>{t(`remoteAccess.operation.${access.operation}`)}{accessedBot ? ` · ${accessedBot.profile.displayName}` : ''}</span>
          <time dateTime={new Date(access.at).toISOString()}>{new Date(access.at).toLocaleString(i18n.locale)}</time></div> : <p>{t('remoteAccess.noAccess')}</p>}
      </section>
    </>}
  </section>;
}

export type RuntimeVariant = 'main' | 'lab' | 'packaged' | 'dev';

export interface RuntimeIdentity {
  readonly variant: RuntimeVariant;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly detail: string;
}

export function getRuntimeIdentity(): RuntimeIdentity {
  const { protocol, hostname, port } = window.location;
  if (port === '5273') {
    return {
      variant: 'lab',
      labelZh: '实验体',
      labelEn: 'Lab',
      detail: `${hostname || '127.0.0.1'}:${port}`,
    };
  }
  if (port === '5173') {
    return {
      variant: 'main',
      labelZh: '本体',
      labelEn: 'Main',
      detail: `${hostname || '127.0.0.1'}:${port}`,
    };
  }
  if (protocol === 'file:') {
    return {
      variant: 'packaged',
      labelZh: '正式版',
      labelEn: 'Packaged',
      detail: 'file://',
    };
  }
  return {
    variant: 'dev',
    labelZh: '开发版',
    labelEn: 'Dev',
    detail: port ? `${hostname || 'localhost'}:${port}` : window.location.href,
  };
}

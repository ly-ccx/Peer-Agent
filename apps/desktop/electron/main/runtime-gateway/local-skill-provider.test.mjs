import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSkillProvider } from './local-skill-provider.mjs';

function mockSkillStore(skills = []) {
  return {
    findSkill: (id) => skills.find((s) => s.skillId === id) ?? null,
    readSkillContext: (id) => {
      const skill = skills.find((s) => s.skillId === id);
      if (!skill) return null;
      return {
        skillId: skill.skillId,
        baseDir: skill.baseDir ?? null,
        frontmatter: {
          name: skill.name,
          description: skill.description ?? '',
          version: skill.version ?? '0.0.0',
          dataLevel: skill.dataLevel ?? 'D1_internal',
          allowedTools: skill.allowedTools ?? [],
          declaredAttachments: [],
        },
        instructions: skill.instructions ?? '',
        attachments: skill.attachments ?? [],
      };
    },
    listSkills: () => skills.map((s) => ({ skillId: s.skillId, name: s.name, description: s.description ?? '', version: s.version ?? '0.0.0', dataLevel: s.dataLevel ?? 'D1_internal' })),
    refresh: () => skills,
  };
}

function makeRequest(capabilityId, args = {}) {
  return {
    call: {
      toolCallId: `tool_${Date.now()}`,
      capabilityId,
      displayName: 'Test',
      reason: 'test',
      arguments: args,
      argumentsPreview: args,
      riskLevel: 'L0_inert',
      dataLevel: 'D1_internal',
      requestedAt: new Date().toISOString(),
    },
  };
}

describe('createLocalSkillProvider', () => {
  it('returns null for unrelated capabilityId', async () => {
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore() });
    const result = await provider.executeCapability(makeRequest('local.web.fetch'));
    assert.equal(result, null);
  });

  it('returns failed result when capabilityId has empty skillId (local.skill.)', async () => {
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore() });
    const result = await provider.executeCapability(makeRequest('local.skill.', {}));
    assert.equal(result.result.status, 'failed');
    assert.equal(result.result.outputPreview.reason, 'missing_skill_id');
    assert.equal(result.grant.granted, false);
  });

  it('returns failed result when skill not found', async () => {
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore() });
    const result = await provider.executeCapability(makeRequest('local.skill.unknown', {}));
    assert.equal(result.result.status, 'failed');
    assert.equal(result.result.outputPreview.reason, 'skill_not_found');
    assert.equal(result.result.outputPreview.skillId, 'unknown');
    assert.equal(result.grant.granted, false);
  });

  it('returns success with skill context when skill found', async () => {
    const skills = [{
      skillId: 'deploy',
      name: 'Deploy',
      description: 'Deploy app',
      version: '1.0.0',
      dataLevel: 'D1_internal',
      allowedTools: ['local.shell.exec'],
      instructions: 'Run deploy script.',
      attachments: [{ path: 'assets/deploy.sh', byteLength: 42 }],
    }];
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
    const result = await provider.executeCapability(makeRequest('local.skill.deploy', {}));

    assert.equal(result.result.status, 'success');
    assert.equal(result.grant.granted, true);
    // 方案 A：outputPreview 是纯文本字符串（instructions 本身）
    assert.equal(typeof result.result.outputPreview, 'string');
    // 原 body 内容必须在其中
    assert.match(result.result.outputPreview, /Run deploy script\./);
    // BLOCKING 约束头必须存在
    assert.match(result.result.outputPreview, /BLOCKING/);
    // 元数据移到 evidence 中
    assert.equal(result.result.evidence.skillId, 'deploy');
    assert.deepEqual(result.result.evidence.allowedTools, ['local.shell.exec']);
    assert.equal(result.result.evidence.attachments.length, 1);
  });

  it('uses zh-CN locale for evidence summary', async () => {
    const skills = [{ skillId: 'test', name: 'Test Skill', instructions: 'body' }];
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
    const result = await provider.executeCapability(
      makeRequest('local.skill.test', {}),
      { locale: 'zh-CN' },
    );
    assert.match(result.result.evidence.summary, /已就绪/);
  });

  it('uses en-US locale for evidence summary', async () => {
    const skills = [{ skillId: 'test', name: 'Test Skill', instructions: 'body' }];
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
    const result = await provider.executeCapability(
      makeRequest('local.skill.test', {}),
      { locale: 'en-US' },
    );
    assert.match(result.result.evidence.summary, /is ready/);
  });

  it('declares correct providerId and capabilityPrefix', () => {
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore() });
    assert.equal(provider.providerId, 'local.skill');
    assert.equal(provider.capabilityPrefix, 'local.skill.');
  });

  it('passes arguments from call args to output', async () => {
    const skills = [{ skillId: 'greet', name: 'Greet', instructions: 'Say hello' }];
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
    const result = await provider.executeCapability(
      makeRequest('local.skill.greet', { arguments: { name: 'World' } }),
    );
    assert.equal(result.result.status, 'success');
    // body 内容在 outputPreview 中
    assert.match(result.result.outputPreview, /Say hello/);
  });

  // Phase 1.5：baseDir 透传 + {baseDir} 占位符自动展开
  it('exposes baseDir and expands {baseDir} placeholder in instructions body', async () => {
    const skills = [{
      skillId: 'xfx',
      name: 'XFX',
      baseDir: '/tmp/skills/xfx',
      instructions: 'Run: cd {baseDir} && python3 -m scripts.create_update',
    }];
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
    const result = await provider.executeCapability(makeRequest('local.skill.xfx', {}));

    // outputPreview 是纯文本
    assert.equal(typeof result.result.outputPreview, 'string');
    // baseDir 在 evidence 中透传
    assert.equal(result.result.evidence.baseDir, '/tmp/skills/xfx');
    // 占位符被自动展开，原始字面不应再出现
    assert.match(
      result.result.outputPreview,
      /Run: cd \/tmp\/skills\/xfx && python3/,
    );
    assert.doesNotMatch(
      result.result.outputPreview,
      /\{baseDir\}/,
    );
    // header 中 baseDir 行（meta 已精简，baseDir 仍在 header 约束中呈现）
    assert.match(result.result.outputPreview, /\/tmp\/skills\/xfx/);
  });

  it('keeps {baseDir} unchanged when skill has no baseDir', async () => {
    const skills = [{ skillId: 'noop', name: 'Noop', instructions: 'cd {baseDir}' }];
    const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
    const result = await provider.executeCapability(makeRequest('local.skill.noop', {}));
    assert.equal(result.result.evidence.baseDir, null);
    // 无 baseDir 时占位符不展开（保持原样以供诊断）
    assert.match(result.result.outputPreview, /cd \{baseDir\}/);
  });

  // Phase 2.0（七层 prompt 约束落地）
  describe('seven-layer prompt constraints envelope', () => {
    // 注：当前 baseline 的 envelope 已精简为「system-reminder + BLOCKING 约束
    // + Skill 元信息 + --- 分隔 + body」。原上游的多层结构（prompt-injection
    // 防御段、hook-feedback 提示、<skill-active> 末尾锚点）在 fork baseline 中
    // 已被有意注释移除（见 local-skill-provider.mjs buildInstructionsEnvelope）。
    // 下列测试断言与当前真实合约对齐；若将来恢复安全层，应同步恢复对应断言。
    it('header includes BLOCKING behavioral constraint', async () => {
      const skills = [{ skillId: 's1', name: 'S1', instructions: 'body' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const zh = await provider.executeCapability(makeRequest('local.skill.s1', {}), { locale: 'zh-CN' });
      assert.match(zh.result.outputPreview, /BLOCKING/);
      // 中文 header 约束核心措辞（当前合约）
      assert.match(zh.result.outputPreview, /严格按照技能指令执行/);
      const en = await provider.executeCapability(makeRequest('local.skill.s1', {}), { locale: 'en-US' });
      assert.match(en.result.outputPreview, /BLOCKING/);
      assert.match(en.result.outputPreview, /execute the instructions below directly/);
    });

    it('current baseline omits prompt-injection defense and hook-feedback layers', async () => {
      // 这些安全层在 baseline 中被精简移除；此测试守护「确实不存在」，
      // 以便将来若无意改变行为时能被发现。
      const skills = [{ skillId: 's2', name: 'S2', instructions: 'body' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const zh = await provider.executeCapability(makeRequest('local.skill.s2', {}), { locale: 'zh-CN' });
      assert.doesNotMatch(zh.result.outputPreview, /Prompt Injection 防御/);
      assert.doesNotMatch(zh.result.outputPreview, /<hook-feedback>/);
      const en = await provider.executeCapability(makeRequest('local.skill.s2', {}), { locale: 'en-US' });
      assert.doesNotMatch(en.result.outputPreview, /Prompt Injection Defense/);
      assert.doesNotMatch(en.result.outputPreview, /<hook-feedback>/);
    });

    it('current baseline does not append <skill-active/> anchor', async () => {
      const skills = [{ skillId: 'anchor-skill', name: 'A', instructions: 'body content' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(makeRequest('local.skill.anchor-skill', {}));
      const text = result.result.outputPreview;
      assert.doesNotMatch(text, /<skill-active/);
    });

    it('preserves header / separator / body structure (Layer 5)', async () => {
      const skills = [{
        skillId: 'three-sec',
        name: 'ThreeSec',
        version: '2.1.0',
        allowedTools: ['local.shell.exec'],
        instructions: 'BODY_MARKER_XYZ',
      }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(makeRequest('local.skill.three-sec', {}));
      const text = result.result.outputPreview;
      // 结构顺序：header(BLOCKING) → --- 分隔 → body
      const headerIdx = text.indexOf('BLOCKING');
      const sepIdx = text.indexOf('\n---\n');
      const bodyIdx = text.indexOf('BODY_MARKER_XYZ');
      assert.ok(headerIdx >= 0 && sepIdx > headerIdx && bodyIdx > sepIdx,
        `unexpected ordering: header=${headerIdx} sep=${sepIdx} body=${bodyIdx}`);
      // body 位于末尾（当前合约无锚点）
      assert.ok(text.trimEnd().endsWith('BODY_MARKER_XYZ'));
    });
  });

  // Phase 2.1: userInput 集成
  describe('userInput integration', () => {
    // 当前合约：用户输入不再渲染为独立段，而是出现在 Skill Meta 的
    // `invocation arguments:` 行（JSON 形式）。这里断言输入值可见即可。
    it('surfaces userMessage value in invocation arguments (zh-CN)', async () => {
      const skills = [{ skillId: 'ui-test', name: 'UITest', instructions: 'do stuff' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(
        makeRequest('local.skill.ui-test', { userMessage: '帮我部署应用' }),
        { locale: 'zh-CN' },
      );
      const text = result.result.outputPreview;
      assert.match(text, /invocation arguments/);
      assert.match(text, /帮我部署应用/);
    });

    it('surfaces input value in invocation arguments (en-US)', async () => {
      const skills = [{ skillId: 'ui-en', name: 'UIEn', instructions: 'do stuff' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(
        makeRequest('local.skill.ui-en', { input: 'deploy to prod' }),
        { locale: 'en-US' },
      );
      const text = result.result.outputPreview;
      assert.match(text, /invocation arguments/);
      assert.match(text, /deploy to prod/);
    });

    it('omits userInput section when no recognizable input field', async () => {
      const skills = [{ skillId: 'no-input', name: 'NoInput', instructions: 'body' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(
        makeRequest('local.skill.no-input', {}),
      );
      const text = result.result.outputPreview;
      assert.doesNotMatch(text, /用户输入/);
      assert.doesNotMatch(text, /User Input/);
    });
  });

  // M1·C：allowed-tools 兜底注入 —— local skill 本质靠 canonical shell 工具执行 instructions
  describe('allowed-tools 兜底注入（C）', () => {
    it('未声明 allowed-tools → 兜底注入 bash（evidence + instructions）', async () => {
      const skills = [{ skillId: 'ata-all', name: 'ata-all', instructions: '调用 aone-kit call-tool' }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(makeRequest('local.skill.ata-all', {}));
      assert.deepEqual(result.result.evidence.allowedTools, ['bash']);
      assert.match(result.result.outputPreview, /allowed-tools/);
      assert.match(result.result.outputPreview, /bash/);
      assert.doesNotMatch(result.result.outputPreview, /local_shell_exec/);
    });

    it('已声明 allowed-tools → 保留不覆盖（兜底不生效）', async () => {
      const skills = [{ skillId: 'deploy', name: 'Deploy', instructions: 'x', allowedTools: ['local.shell.exec'] }];
      const provider = createLocalSkillProvider({ skillStore: mockSkillStore(skills) });
      const result = await provider.executeCapability(makeRequest('local.skill.deploy', {}));
      assert.deepEqual(result.result.evidence.allowedTools, ['local.shell.exec']);
    });
  });
});

import { clientApi } from '../../clientApi';

export async function readInstalledSkills() {
  const workspaces = (await clientApi.listSkillInstallTargets()).filter((target) => target.available);
  const list = await clientApi.listSkills(workspaces.map((workspace) => workspace.path));
  return { list, workspaces };
}

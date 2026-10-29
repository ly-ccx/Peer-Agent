import type {ChatController} from './chat-controller.ts';
import type {TuiLocale} from './tui-language.ts';
import {expandImageChipsInText,isSlashCommandInput,loadLocalImageAttachments} from './composer-image-paths.ts';

interface ComposerSubmission {
  readonly value: string;
  readonly locale: TuiLocale;
  readonly controller: Pick<ChatController,'getSnapshot'|'send'>;
  readonly imagePathRegistry: ReadonlyMap<string,string>;
  readonly isCurrentDraft: () => boolean;
  readonly clearDraft: () => void;
  readonly restoreDraft: () => void;
  readonly onBeforeSend: () => void;
  readonly onCommandInput: (text:string) => boolean;
  readonly onNotice: (notice:string|null) => void;
}

/** Prepare one draft at a time; attachment failures never consume the draft. */
export function createComposerSubmission(options: {loadAttachments?:typeof loadLocalImageAttachments} = {}) {
  let preparing=false;
  return {async submit(input:ComposerSubmission) {
    if(preparing||!input.value.trim())return;
    const copy=(zh:string,en:string)=>input.locale==='zh-CN'?zh:en;
    if(input.controller.getSnapshot().status!=='idle') {
      input.onNotice(copy('正在回复，请先按 Esc 停止再发送。','A reply is running. Press Esc to stop it before sending.'));return;
    }
    if(isSlashCommandInput(input.value.trim())) {
      if(input.onCommandInput(input.value.trim()))input.clearDraft();return;
    }
    preparing=true;
    let cleared=false;
    const failed=(error:unknown)=>{
      if(cleared)input.restoreDraft();
      const detail=error instanceof Error?error.message:String(error);
      input.onNotice(`${copy('发送失败，草稿已保留','Could not send; draft preserved')}: ${detail}`);
    };
    try {
      input.onNotice(copy('正在准备消息…','Preparing message…'));
      const expanded=expandImageChipsInText(input.value,input.imagePathRegistry);
      if(/\[Image [^\]]+\]/.test(expanded))throw new Error(copy('图片引用已失效，请重新粘贴图片。','The image reference expired. Paste the image again.'));
      const attachment=await (options.loadAttachments??loadLocalImageAttachments)(input.value,{pathByKey:input.imagePathRegistry});
      if(attachment.missingPaths.length)throw new Error(copy('图片无法读取，请重新粘贴图片。','An image could not be read. Paste it again.'));
      if(!input.isCurrentDraft()) {input.onNotice(copy('草稿已变化，请重新发送。','The draft changed. Send it again.'));return;}
      if(input.controller.getSnapshot().status!=='idle') {input.onNotice(copy('正在回复，草稿已保留。','A reply is running; draft preserved.'));return;}
      const text=attachment.text.trim()?attachment.text:attachment.images.length?'':attachment.displayContent;
      if(!text.trim()&&!attachment.images.length)return;
      input.onBeforeSend();
      const completion=input.controller.send(text,attachment.images.length?{images:attachment.images}:undefined);
      input.clearDraft();cleared=true;
      input.onNotice(null);
      void completion.then(result=>{
        if(result.status==='skipped') {
          input.restoreDraft();
          input.onNotice(copy('消息未提交，草稿已保留。','Message was not submitted; draft preserved.'));
        }
      }).catch(failed);
    } catch(error) {failed(error);}
    finally {preparing=false;}
  }};
}

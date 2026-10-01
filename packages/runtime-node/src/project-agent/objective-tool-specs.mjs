const object = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false});
const string = maxLength => ({type:'string',minLength:1,maxLength});
const array = (items,maxItems) => ({type:'array',items,maxItems});
const probe = {anyOf:[
  object({type:{const:'deterministic'},check:{const:'git_ref'},spec:object({ref:string(200)},['ref'])},['type','check','spec']),
  object({type:{const:'deterministic'},check:{const:'file_hash'},spec:object({path:string(500)},['path'])},['type','check','spec']),
  object({type:{const:'deterministic'},check:{const:'command'},spec:object({command:{const:'gh_run_list'},workflow:string(200)},['command'])},['type','check','spec']),
  object({type:{const:'agent'},question:string(1000)},['type','question']),
]};
const schedule = object({kind:{type:'string',enum:['once','hourly','daily','weekdays','weekly','monthly','custom_cron']},timezone:string(100),onceAt:string(40),everyHours:{type:'integer',minimum:1,maximum:24},hour:{type:'integer',minimum:0,maximum:23},minute:{type:'integer',minimum:0,maximum:59},weekdays:array({type:'integer',minimum:1,maximum:7},7),dayOfMonth:{type:'integer',minimum:1,maximum:31},cron:string(200)},['kind','timezone']);
const source={anyOf:[object({type:{const:'task_event'},filter:{type:'string',enum:['failed','ended','verified']}},['type','filter']),object({type:{const:'git'},ref:string(200),on:{type:'string',enum:['new_commits','new_tag']}},['type','ref','on']),object({type:{const:'files'},paths:array(string(500),16),debounceMs:{const:5000}},['type','paths'])]};
const watch={anyOf:[object({notificationPolicy:{type:'string',enum:['changes','failure_only']},watchId:string(200),kind:{const:'schedule'},schedule,probe},['watchId','kind','schedule','probe']),object({notificationPolicy:{type:'string',enum:['changes','failure_only']},watchId:string(200),kind:{const:'event'},source,probe},['watchId','kind','source'])]};
const fields={autoAccept:{type:'boolean'},title:string(120),outcome:string(2000),autonomy:{type:'string',enum:['report_only','propose','act']},watches:array(watch,16),
  milestones:array(object({id:string(200),title:string(200),sessionIds:array(string(200),100),status:{type:'string',enum:['pending','active','done','dropped']}},['id','title','sessionIds','status']),32),
  successSignals:array(object({signalId:string(200),watchId:string(200),operator:{type:'string',enum:['equals','contains','succeeded']},value:string(500)},['signalId','watchId','operator']),16),
  budget:object({maxAutoSessionsPerDay:{type:'integer',minimum:0,maximum:3},maxProbeRunsPerDay:{type:'integer',minimum:1,maximum:1440}},['maxAutoSessionsPerDay','maxProbeRunsPerDay']),deadline:string(40)};
const spec=(name,inputSchema)=>Object.freeze({name,capabilityId:`local.delegation.${name}`,inputSchema});
export const OBJECTIVE_TOOL_SPECS=Object.freeze([
  spec('create_objective',object({...fields,anchorMessageId:string(200),createdBy:{type:'string',enum:['user_request','agent_proposal']}},['title','outcome','anchorMessageId'])),
  spec('update_objective',object({...fields,objectiveId:string(200),anchorMessageId:string(200),expectedVersion:{type:'integer',minimum:1}},['objectiveId'])),
  spec('pause_objective',object({objectiveId:string(200)},['objectiveId'])),
  spec('resume_objective',object({objectiveId:string(200),anchorMessageId:string(200)},['objectiveId','anchorMessageId'])),
  spec('list_objectives',object({})),
  spec('get_objective',object({objectiveId:string(200)},['objectiveId'])),
  spec('close_objective',object({objectiveId:string(200),status:{type:'string',enum:['achieved','abandoned']},evidenceRefs:array(string(500),32)},['objectiveId','status'])),
]);

function issues(rule, value, path = '') {
  if (rule.anyOf) return rule.anyOf.map(option => issues(option, value, path)).sort((a,b) => a.length-b.length)[0];
  const fail = reason => [`${path || 'input'}: ${reason}`];
  if (Object.hasOwn(rule, 'const') && value !== rule.const) return fail(`expected ${rule.const}`);
  if (rule.enum && !rule.enum.includes(value)) return fail(`expected ${rule.enum.join('/')}`);
  if (rule.type === 'string') return typeof value === 'string' && !!value.trim() && value.length >= (rule.minLength || 0) && value.length <= (rule.maxLength || Infinity) ? [] : fail('invalid string');
  if (rule.type === 'boolean') return typeof value==='boolean' ? [] : fail('expected boolean');
  if (rule.type === 'integer') return Number.isInteger(value) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity) ? [] : fail('integer outside allowed range');
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems || 0) || value.length > (rule.maxItems || Infinity)) return fail('invalid list');
    return value.flatMap((item,index) => issues(rule.items,item,`${path}[${index}]`));
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected object');
    const at = child => path ? `${path}.${child}` : child;
    return [...(rule.required || []).filter(child => !Object.hasOwn(value,child)).map(child=>`${at(child)}: required`),
      ...Object.entries(value).flatMap(([child,item])=>Object.hasOwn(rule.properties,child) ? issues(rule.properties[child],item,at(child)) : [`${at(child)}: forbidden`])];
  }
  return [];
}

export function validateObjectivePlanFields(input) {
  return issues(object(fields), input).length === 0;
}
export function validateObjectiveToolInput(name, input) {
  const spec = OBJECTIVE_TOOL_SPECS.find(item => item.name === name);
  const failures = spec ? issues(spec.inputSchema,input) : ['tool: unknown'];
  return failures.length === 0 ? {ok:true,value:structuredClone(input)}
    : {ok:false,error:'invalid_input',message:`Objective input has missing, invalid or forbidden fields: ${failures.slice(0,8).join('; ')}`.slice(0,1200)};
}

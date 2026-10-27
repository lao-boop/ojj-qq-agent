const schema = (name, description, properties, required=[]) => ({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const str = {type:'string'};
export const PROJECT_SPECS = [
  schema('project_create','老板交办项目给登记成员；当前消息附件作为交办材料一同发送。缺负责人/交付要求先追问，不擅自指定人。',{title:str,description:str,assignees:str,deadline:str},['title','description','assignees']),
  schema('project_status','查询自己有权限的项目及原始进展、发送状态。projectId为空列出可见项目。',{projectId:str}),
  schema('project_update','负责人反馈进度/阻塞/提交交付。submitted是待老板验收，不代表完成。当前消息附件转交老板。',{projectId:str,text:str,state:{type:'string',enum:['working','blocked','submitted']}},['projectId','state']),
  schema('project_review','仅交办老板可以验收指定负责人的已提交结果，或带原因退回。',{projectId:str,member:str,decision:{type:'string',enum:['accept','rework']},text:str},['projectId','member','decision']),
  schema('project_remind','仅项目老板可以提醒尚未提交的负责人，限制催办频率。',{projectId:str},['projectId']),
  schema('project_files','将项目材料原文件发送给当前请求者；老板可看全部，成员仅看交办材料与自己的交付。',{projectId:str},['projectId']),
];
export function attachProjectTools(tools, secretary) {
  if (!secretary.enabled()) return tools;
  return {...tools,specs:[...tools.specs,...PROJECT_SPECS],async run(name,args,ctx){
    if (!PROJECT_SPECS.some(s=>s.function.name===name)) return tools.run(name,args,ctx);
    return JSON.stringify(await secretary.execute(name,args,ctx));
  }};
}

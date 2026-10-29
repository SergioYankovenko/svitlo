// GITHUB_TOKEN pushes do not trigger legacy Pages automatically. Request a build explicitly.
const repository=process.env.GITHUB_REPOSITORY;
if(repository!=='SergioYankovenko/svitlo'||!process.env.GITHUB_TOKEN)throw new Error('Unexpected deployment repository or missing token');
const response=await fetch(`https://api.github.com/repos/${repository}/pages/builds`,{
 method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
 headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2026-03-10'},
});
if(response.status!==201)throw new Error(`Pages build request HTTP ${response.status}`);
console.log('Existing branch-based Pages build requested');

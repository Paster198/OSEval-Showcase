import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'public', 'data', 'past_projects');
const pastProjectsJsonPath = path.join(process.cwd(), '..', 'past_projects.json');
const outputFilePath = path.join(process.cwd(), 'public', 'data', 'index.json');

function main() {
  const projects = [];

  let globalData = [];
  try {
    globalData = JSON.parse(fs.readFileSync(pastProjectsJsonPath, 'utf8'));
  } catch (e) {
    console.warn("Could not read parent past_projects.json", e);
  }

  const dirs = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const dir of dirs) {
    const projectPath = path.join(dataDir, dir);
    
    let features = {};
    let metadata = {};
    let brief = '';

    try {
      const featuresContent = fs.readFileSync(path.join(projectPath, 'features.json'), 'utf8');
      features = JSON.parse(featuresContent);
    } catch (e) {
      console.warn(`Could not read features.json for ${dir}`);
    }

    try {
      brief = fs.readFileSync(path.join(projectPath, 'brief.md'), 'utf8');
    } catch (e) {
      console.warn(`Could not read brief.md for ${dir}`);
    }

    const globalInfo = globalData.find(item => item.id === dir || item.workspace_path === dir);
    
    try {
      const metadataContent = fs.readFileSync(path.join(projectPath, 'metadata.json'), 'utf8');
      metadata = JSON.parse(metadataContent);
    } catch (e) {
      // If metadata.json doesn't exist, we construct it from globalInfo or dir name
      let year = '';
      let teamname = '';
      let repourl = globalInfo ? globalInfo.source : '';

      // Infer year and teamname from directory name (e.g. 学校-队伍名-T2024...)
      const parts = dir.split('-');
      if (parts.length >= 3) {
        teamname = parts[1];
        const match = dir.match(/T(\d{4})/);
        if (match) {
          year = match[1];
        } else if (dir.includes('2024')) {
          year = '2024';
        } else if (dir.includes('2025')) {
          year = '2025';
        }
      }

      metadata = {
        year,
        teamname,
        repourl
      };

      // Optionally write it back so the detail page can fetch it directly
      fs.writeFileSync(path.join(projectPath, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
    }

    projects.push({
      id: dir,
      features,
      metadata,
      brief
    });
  }

  fs.writeFileSync(outputFilePath, JSON.stringify(projects, null, 2), 'utf8');
  console.log(`Generated index.json with ${projects.length} projects.`);
}

main();

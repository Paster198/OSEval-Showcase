import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import './Home.css';

function Home() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('data/index.json')
      .then(res => res.json())
      .then(data => {
        setProjects(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load projects", err);
        setLoading(false);
      });
  }, []);

  return (
    <div className="home">
      <header className="home-header">
        <h1>评测结果</h1>
        <p className="subtitle">以下所有项目均使用 Qwen3.7-Max 或者 DeepSeek V4 Pro 搭配本Agent完成分析。</p>
      </header>

      {loading ? (
        <div className="loading">加载中...</div>
      ) : (
        <div className="project-grid">
          {projects.map((proj) => {
            const year = proj.metadata?.year || '未知年份';
            const name = proj.features?.name || proj.id;
            const team = proj.metadata?.teamname || '未知队伍';
            const lang = proj.features?.language || '未知语言';
            const arch = (proj.features?.architectures || []).join(', ') || '未知架构';
            const highlights = (proj.features?.highlights || []).join('；');

            return (
              <Link to={`/project/${encodeURIComponent(proj.id)}`} key={proj.id} className="project-card">
                <div className="card-header">
                  <h2>{year} {name}</h2>
                </div>
                <div className="card-body">
                  <div className="card-meta">
                    <div><strong>队伍:</strong> {team}</div>
                    <div><strong>语言:</strong> {lang}</div>
                    <div><strong>架构:</strong> {arch}</div>
                  </div>
                  <div className="card-details">
                    <div className="highlights" title={highlights}>
                      <strong>亮点:</strong> {highlights || '无'}
                    </div>
                    <div className="brief">
                      {proj.brief}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Home;

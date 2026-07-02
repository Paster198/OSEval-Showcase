import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import './Home.css';

function Home() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLang, setFilterLang] = useState('');
  const [filterArch, setFilterArch] = useState('');
  const [filterKernel, setFilterKernel] = useState('');
  const [filterYear, setFilterYear] = useState('');

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

  // Compute unique filter options
  const { langs, archs, kernels, years } = useMemo(() => {
    const l = new Set();
    const a = new Set();
    const k = new Set();
    const y = new Set();
    
    projects.forEach(p => {
      const lang = p.features?.language;
      if (lang) l.add(lang);
      
      const pArchs = p.features?.architectures || [];
      pArchs.forEach(arch => arch && a.add(arch));
      
      const kernel = p.features?.kernel_type;
      if (kernel) k.add(kernel);
      
      const year = p.metadata?.year;
      if (year) y.add(year);
    });

    return {
      langs: Array.from(l).sort(),
      archs: Array.from(a).sort(),
      kernels: Array.from(k).sort(),
      years: Array.from(y).sort((a, b) => b - a)
    };
  }, [projects]);

  // Filter projects based on state
  const filteredProjects = useMemo(() => {
    const result = projects.filter(p => {
      const pLang = p.features?.language || '未知语言';
      const pArchs = p.features?.architectures || [];
      const pKernel = p.features?.kernel_type || '未知类型';
      const pYear = p.metadata?.year?.toString() || '未知年份';
      const pName = p.features?.name || p.id || '';
      const pRepo = p.metadata?.repourl || '';

      // Language filter
      if (filterLang && filterLang !== pLang) return false;
      // Arch filter
      if (filterArch && !pArchs.includes(filterArch)) return false;
      // Kernel filter
      if (filterKernel && filterKernel !== pKernel) return false;
      // Year filter
      if (filterYear && filterYear !== pYear) return false;
      
      // Search text (by name or repourl)
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!pName.toLowerCase().includes(q) && !pRepo.toLowerCase().includes(q)) {
          return false;
        }
      }

      return true;
    });

    // Sort by year descending (newer projects first)
    result.sort((a, b) => {
      const yearA = parseInt(a.metadata?.year) || 0;
      const yearB = parseInt(b.metadata?.year) || 0;
      return yearB - yearA;
    });

    return result;
  }, [projects, filterLang, filterArch, filterKernel, filterYear, searchQuery]);

  return (
    <div className="home">
      <header className="home-header">
        <h1>proj18 - 010 结果展示</h1>
        <p className="subtitle">以下所有项目均使用 Qwen3.7-Max 或者 DeepSeek V4 Pro 搭配本Agent完成分析。</p>
      </header>

      {loading ? (
        <div className="loading">加载中...</div>
      ) : (
        <>
          <div className="filters-section">
            <input 
              type="text" 
              placeholder="搜索作品名或仓库地址..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            <div className="dropdowns">
              <select value={filterYear} onChange={e => setFilterYear(e.target.value)}>
                <option value="">全部年份</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <select value={filterLang} onChange={e => setFilterLang(e.target.value)}>
                <option value="">全部实现语言</option>
                {langs.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <select value={filterArch} onChange={e => setFilterArch(e.target.value)}>
                <option value="">全部支持架构</option>
                {archs.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <select value={filterKernel} onChange={e => setFilterKernel(e.target.value)}>
                <option value="">全部内核类型</option>
                {kernels.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          </div>

          <div className="project-grid">
            {filteredProjects.map((proj) => {
              const year = proj.metadata?.year || '未知年份';
              const name = proj.features?.name || proj.id;
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
                      <div><strong>语言:</strong> {lang}</div>
                      <div><strong>架构:</strong> {arch}</div>
                      <div><strong>类型:</strong> {proj.features?.kernel_type || '未知类型'}</div>
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
            
            {filteredProjects.length === 0 && (
              <div className="no-results">
                无结果。<br />
                - 搜索作品名或者作品在提交情况fork url里的url<br />
                - 搜索的作品可能由于仓库被锁或者内容过少而被跳过分析。
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default Home;

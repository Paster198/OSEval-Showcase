import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './ProjectDetail.css';

function ProjectDetail() {
  const { id } = useParams();
  const [activeTab, setActiveTab] = useState('basic');
  const [projectData, setProjectData] = useState({
    features: null,
    metadata: null,
    brief: '',
    survey: '',
    full: '',
    eval: ''
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const basePath = `data/past_projects/${id}`;
        
        // Load JSON files
        const [featuresRes, metadataRes] = await Promise.all([
          fetch(`${basePath}/features.json`).catch(() => null),
          fetch(`${basePath}/metadata.json`).catch(() => null)
        ]);
        
        const features = featuresRes && featuresRes.ok ? await featuresRes.json().catch(()=>null) : null;
        const metadata = metadataRes && metadataRes.ok ? await metadataRes.json().catch(()=>null) : null;

        // Load Markdown files
        const loadMd = async (name) => {
          try {
            const res = await fetch(`${basePath}/${name}.md`);
            if (res.ok) return await res.text();
            return `*未能加载 ${name}.md*`;
          } catch (e) {
            return `*未能加载 ${name}.md*`;
          }
        };

        const [brief, survey, full, evalReport] = await Promise.all([
          loadMd('brief'),
          loadMd('survey_report'),
          loadMd('full_report'),
          loadMd('eval_report')
        ]);

        setProjectData({
          features,
          metadata,
          brief,
          survey,
          full,
          eval: evalReport
        });
      } catch (err) {
        console.error("Error loading project details", err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [id]);

  if (loading) {
    return <div className="loading">加载中...</div>;
  }

  const renderBasicInfo = () => {
    const f = projectData.features || {};
    const m = projectData.metadata || {};

    return (
      <div className="basic-info">
        <div className="info-section">
          <h3>元信息 (Metadata)</h3>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">参赛年份</span>
              <span className="info-value">{m.year || '-'}</span>
            </div>

            <div className="info-item">
              <span className="info-label">仓库链接</span>
              <span className="info-value">
                {m.repourl ? <a href={m.repourl} target="_blank" rel="noreferrer">{m.repourl}</a> : '-'}
              </span>
            </div>
          </div>
        </div>

        <div className="info-section">
          <h3>项目特征 (Features)</h3>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">项目名称</span>
              <span className="info-value">{f.name || '-'}</span>
            </div>
            <div className="info-item">
              <span className="info-label">内核类型</span>
              <span className="info-value">{f.kernel_type || '-'}</span>
            </div>
            <div className="info-item">
              <span className="info-label">生态系统</span>
              <span className="info-value">{f.ecosystem || '-'}</span>
            </div>
            <div className="info-item">
              <span className="info-label">主要语言</span>
              <span className="info-value">{f.language || '-'}</span>
            </div>
            <div className="info-item">
              <span className="info-label">支持架构</span>
              <span className="info-value">{(f.architectures || []).join(', ') || '-'}</span>
            </div>
          </div>
        </div>

        <div className="info-section">
          <h3>项目亮点</h3>
          <ul className="highlights-list">
            {(f.highlights || []).map((hl, i) => (
              <li key={i}>{hl}</li>
            ))}
          </ul>
        </div>

        <div className="info-section">
          <h3>项目简介 (Brief)</h3>
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{projectData.brief}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  };

  const renderMarkdown = (content) => {
    return (
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  };

  return (
    <div className="project-detail">
      <div className="detail-header">
        <Link to="/" className="back-link">← 返回首页</Link>
        <h2>{projectData.metadata?.year} {projectData.features?.name || id}</h2>
      </div>

      <div className="tabs">
        <button 
          className={`tab-btn ${activeTab === 'basic' ? 'active' : ''}`}
          onClick={() => setActiveTab('basic')}
        >基本信息</button>
        <button 
          className={`tab-btn ${activeTab === 'survey' ? 'active' : ''}`}
          onClick={() => setActiveTab('survey')}
        >普查报告</button>
        <button 
          className={`tab-btn ${activeTab === 'full' ? 'active' : ''}`}
          onClick={() => setActiveTab('full')}
        >技术报告</button>
        <button 
          className={`tab-btn ${activeTab === 'eval' ? 'active' : ''}`}
          onClick={() => setActiveTab('eval')}
        >评估报告</button>
      </div>

      <div className="tab-content card-bg">
        {activeTab === 'basic' && renderBasicInfo()}
        {activeTab === 'survey' && renderMarkdown(projectData.survey)}
        {activeTab === 'full' && renderMarkdown(projectData.full)}
        {activeTab === 'eval' && renderMarkdown(projectData.eval)}
      </div>
    </div>
  );
}

export default ProjectDetail;

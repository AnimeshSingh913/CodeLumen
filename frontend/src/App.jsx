import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Play, Activity, GripHorizontal } from 'lucide-react';
import { customThemes } from './themes';
import { Header } from './components/layout/Header';
import { EditorToolbar } from './components/editor/EditorToolbar';
import { CodeEditor } from './components/editor/CodeEditor';
import { InputPanel } from './components/panels/InputPanel';
import { OutputPanel } from './components/panels/OutputPanel';
import { BulkAddModal } from './components/modals/BulkAddModal';
import { useCodeExecution } from './hooks/useCodeExecution';
import { useAiChat } from './hooks/useAiChat';
import { storage } from './utils/storage';

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '');
const codeKey = (lang) => `codelumen_code_${lang}`;

// The admin dashboard (and its charting library) loads only when opened.
const AnalyticsDashboard = lazy(() =>
  import('./components/dashboard/AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard }))
);

const defaultTemplates = {
  cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}`,
  java: `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}`,
  py: `print("Hello, World!")`
};

const languageConfig = {
  cpp: { name: 'C++', color: 'from-blue-500 to-cyan-500', monaco: 'cpp', extension: 'cpp' },
  java: { name: 'Java', color: 'from-orange-500 to-red-500', monaco: 'java', extension: 'java' },
  py: { name: 'Python', color: 'from-green-500 to-emerald-500', monaco: 'python', extension: 'py' }
};

// Restore the user's last code for a language, or its starter template.
const loadCode = (lang) => storage.get(codeKey(lang)) ?? defaultTemplates[lang];

function App() {
  const [language, setLanguage] = useState(() => {
    const saved = storage.get('codelumen_language');
    return languageConfig[saved] ? saved : 'cpp';
  });
  const [code, setCode] = useState(() => loadCode(language));
  const [input, setInput] = useState('');
  const [theme, setTheme] = useState('dark');
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState('output');
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [serverStatus, setServerStatus] = useState('waking');
  const [showDashboard, setShowDashboard] = useState(window.location.hash === '#dashboard');

  const [mode, setMode] = useState('custom');
  const [testCases, setTestCases] = useState([{ input: '', expectedOutput: '' }]);
  const [editorTheme, setEditorTheme] = useState('vs-dark');
  const editorRef = useRef(null);

  // Vertical Draggable Resizer State (Right Column)
  const [splitPercent, setSplitPercent] = useState(() => {
    const saved = Number(storage.get('codelumen_panel_split'));
    return saved >= 12 && saved <= 85 ? saved : 32; // Default 32% for top input, 68% for output/chat
  });
  const [isInputCollapsed, setIsInputCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const rightColumnRef = useRef(null);

  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleTouchStart = () => {
    setIsDragging(true);
  };

  useEffect(() => {
    const handleMove = (clientY) => {
      if (!isDragging || !rightColumnRef.current) return;
      const rect = rightColumnRef.current.getBoundingClientRect();
      const relativeY = clientY - rect.top;
      const newPercent = (relativeY / rect.height) * 100;

      if (newPercent < 8) {
        setIsInputCollapsed(true);
      } else {
        setIsInputCollapsed(false);
        const clamped = Math.max(12, Math.min(85, newPercent));
        setSplitPercent(clamped);
        storage.set('codelumen_panel_split', String(clamped));
      }
    };

    const onMouseMove = (e) => handleMove(e.clientY);
    const onTouchMove = (e) => {
      if (e.touches && e.touches[0]) handleMove(e.touches[0].clientY);
    };

    const stopDragging = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', stopDragging);
      window.addEventListener('touchmove', onTouchMove);
      window.addEventListener('touchend', stopDragging);
    }

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', stopDragging);
    };
  }, [isDragging]);
  
  const activeApiUrl = API_URL;
  const isDark = theme === 'dark';

  const {
    chatMessages, isChatLoading, chatInput, setChatInput, chatScrollRef, handleSendChat, setChatMessages, aiUsage, fetchAiLimitStatus
  } = useAiChat(activeApiUrl, language, code);

  const {
    output, setOutput, isRunning, executionTime, setExecutionTime,
    testResults, setTestResults, complexity, setComplexity,
    isAnalyzing, handleSubmit, handleManualAnalyze
  } = useCodeExecution(activeApiUrl, language, code, input, mode, testCases, setActiveTab, fetchAiLimitStatus);

  // Free hosting tiers sleep when idle, so retry the health check for ~1 minute.
  useEffect(() => {
    let cancelled = false;
    const checkServer = async () => {
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        try {
          const res = await fetch(`${activeApiUrl}/health`, { signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            if (!cancelled) setServerStatus('online');
            return;
          }
        } catch {
          /* server still waking up */
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!cancelled) setServerStatus('error');
    };
    checkServer();
    return () => {
      cancelled = true;
    };
  }, [activeApiUrl]);

  useEffect(() => {
    const onHashChange = () => setShowDashboard(window.location.hash === '#dashboard');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    storage.set('codelumen_language', language);
  }, [language]);

  useEffect(() => {
    storage.set(codeKey(language), code);
  }, [language, code]);

  useEffect(() => {
    document.body.className = isDark ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-900';
  }, [isDark]);

  const handleLanguageChange = (selectedLang) => {
    setLanguage(selectedLang);
    setCode(loadCode(selectedLang));
    setOutput(''); 
    setComplexity(''); 
    setExecutionTime(null); 
    setTestResults(null);
  };

  const handleResetCode = () => {
    if (window.confirm(`Replace your ${languageConfig[language].name} code with the starter template?`)) {
      setCode(defaultTemplates[language]);
    }
  };

  const handleEditorWillMount = (monaco) => {
    Object.keys(customThemes).forEach(themeName => {
      monaco.editor.defineTheme(themeName, customThemes[themeName]);
    });
  };

  const handleBulkImport = () => {
    if (!bulkText.trim()) return;

    const cases = bulkText.split('===').map(tc => tc.trim()).filter(tc => tc);
    const newTestCases = [];

    cases.forEach(tc => {
      const parts = tc.split('---');
      if (parts.length >= 1) {
        newTestCases.push({
          input: parts[0].trim(),
          expectedOutput: (parts[1] || '').trim()
        });
      }
    });

    if (newTestCases.length > 0) {
      setTestCases(newTestCases);
    }
    setShowBulkModal(false);
    setBulkText('');
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard permission denied */
    }
  };

  const handleDownload = () => {
    const langDetails = languageConfig[language];
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `main.${langDetails.extension}`; // e.g., main.cpp
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const currentLang = languageConfig[language];

  if (showDashboard) {
    return (
      <div className={`min-h-screen lg:h-screen w-full lg:overflow-hidden transition-all duration-300 ${isDark
        ? 'bg-slate-900'
        : 'bg-slate-50'
        }`}>
        <Suspense fallback={null}>
          <AnalyticsDashboard isDark={isDark} activeApiUrl={activeApiUrl} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className={`min-h-screen lg:h-screen w-full lg:overflow-hidden transition-all duration-300 ${isDark
      ? 'bg-slate-900'
      : 'bg-slate-50'
      }`}>

      <div className="relative z-10 flex h-full flex-col p-2 sm:p-4">
        <Header 
          serverStatus={serverStatus}
          theme={theme}
          setTheme={setTheme}
          isDark={isDark}
        />

        <main className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0 overflow-y-auto lg:overflow-hidden">

          <section className="w-full lg:w-7/12 flex flex-col min-h-0">
            <div className={`flex-1 min-h-0 flex flex-col rounded-xl shadow-lg border overflow-hidden ${isDark
              ? 'bg-gray-900/80 border-blue-500/30 shadow-blue-500/20'
              : 'bg-white/90 border-gray-200 shadow-gray-300/30'
              }`}>

              <EditorToolbar 
                currentLang={currentLang}
                languageConfig={languageConfig}
                language={language}
                handleLanguageChange={handleLanguageChange}
                editorTheme={editorTheme}
                setEditorTheme={setEditorTheme}
                theme={theme}
                setTheme={setTheme}
                isDark={isDark}
                handleDownload={handleDownload}
                copyToClipboard={copyToClipboard}
                copied={copied}
                handleResetCode={handleResetCode}
              />

              <CodeEditor 
                isDark={isDark}
                currentLang={currentLang}
                code={code}
                setCode={setCode}
                editorTheme={editorTheme}
                handleEditorWillMount={handleEditorWillMount}
                editorRef={editorRef}
              />

              {/* ACTION FOOTER (Desktop Only >= 1024px) */}
              <div className={`p-3 border-t hidden lg:flex flex-row items-center justify-end gap-3 flex-shrink-0 ${isDark ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
                <div className="flex items-center space-x-3 w-auto">
                  <button
                    onClick={() => {
                      if (activeTab === 'custom' || activeTab === 'tests') setActiveTab('output');
                      handleSubmit();
                    }}
                    disabled={isRunning}
                    className={`flex-1 sm:flex-none flex items-center justify-center space-x-2 px-6 py-2 rounded-lg font-bold text-white shadow-lg transition-all transform hover:scale-[1.02] active:scale-95 ${isRunning
                        ? 'bg-gray-500 cursor-not-allowed'
                        : 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500'
                      }`}
                  >
                    {isRunning ? (
                      <Activity className="w-5 h-5 animate-spin" />
                    ) : (
                      <Play className="w-5 h-5 fill-current" />
                    )}
                    <span>{isRunning ? 'Running...' : 'Run Code'}</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Right Column: Resizable Top (Input) and Bottom (Output) */}
          <section 
            ref={rightColumnRef}
            className="w-full lg:w-5/12 flex flex-col min-h-[600px] lg:min-h-0 relative"
          >
            {/* Top Input Panel */}
            {!isInputCollapsed && (
              <InputPanel 
                style={{ flex: `${splitPercent} ${splitPercent} 0%` }}
                mode={mode}
                setMode={setMode}
                input={input}
                setInput={setInput}
                testCases={testCases}
                setTestCases={setTestCases}
                setShowBulkModal={setShowBulkModal}
                isDark={isDark}
              />
            )}

            {/* Draggable Divider Handle */}
            <div
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
              className={`py-1.5 flex items-center justify-center cursor-row-resize select-none z-10 group relative transition-colors ${
                isDragging ? 'opacity-100' : 'opacity-85 hover:opacity-100'
              }`}
              title="Drag up/down to resize panels. Click button to collapse/expand input."
            >
              <div className={`w-full h-1 rounded-full transition-all flex items-center justify-center relative ${
                isDragging 
                  ? 'bg-blue-500 h-1.5 shadow-md ring-2 ring-blue-400/50' 
                  : isDark ? 'bg-gray-700/80 group-hover:bg-blue-500/60' : 'bg-gray-300 group-hover:bg-blue-400'
              }`}>
                <div className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium flex items-center gap-1.5 shadow-sm border transition-all ${
                  isDark ? 'bg-gray-800 border-gray-700 text-gray-300' : 'bg-white border-gray-200 text-gray-600'
                }`}>
                  <GripHorizontal className="w-3.5 h-3.5 text-gray-400" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsInputCollapsed(!isInputCollapsed);
                    }}
                    className="hover:text-blue-400 font-semibold cursor-pointer transition-colors"
                    title={isInputCollapsed ? "Expand Input Panel" : "Collapse Input Panel for Full Chat / Output"}
                  >
                    {isInputCollapsed ? "▼ Expand Input" : "▲ Collapse Input"}
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom Output / Chat Panel */}
            <OutputPanel 
              style={{ flex: isInputCollapsed ? '1 1 0%' : `${100 - splitPercent} ${100 - splitPercent} 0%` }}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              mode={mode}
              output={output}
              executionTime={executionTime}
              isDark={isDark}
              testResults={testResults}
              complexity={complexity}
              isAnalyzing={isAnalyzing}
              handleManualAnalyze={handleManualAnalyze}
              chatMessages={chatMessages}
              chatScrollRef={chatScrollRef}
              isChatLoading={isChatLoading}
              chatInput={chatInput}
              setChatInput={setChatInput}
              handleSendChat={handleSendChat}
              setChatMessages={setChatMessages}
              aiUsage={aiUsage}
            />
          </section>
        </main>
      </div>

      <BulkAddModal 
        showBulkModal={showBulkModal}
        setShowBulkModal={setShowBulkModal}
        bulkText={bulkText}
        setBulkText={setBulkText}
        handleBulkImport={handleBulkImport}
        isDark={isDark}
      />
    </div>
  );
}

export default App;
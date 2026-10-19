import { useState, useEffect, useRef } from 'react';

export const useCodeExecution = (activeApiUrl, language, code, input, mode, testCases, setActiveTab, onAiUsed) => {
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [executionTime, setExecutionTime] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [complexity, setComplexity] = useState("Analysis not requested");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleSubmit = async () => {
    setIsRunning(true);
    setOutput('');
    setExecutionTime(null);
    setTestResults(null);
    setActiveTab('output');

    try {
      const startTime = Date.now();

      const payload = mode === 'custom'
        ? { language, code, input }
        : { language, code, testCases };

      const endpoint = mode === 'custom' ? '/run' : '/run-tests';

      const response = await fetch(`${activeApiUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      setExecutionTime(data.executionTimeMs ?? Date.now() - startTime);

      if (mode === 'custom') {
        if (data.output !== undefined && data.success !== false) {
          setOutput(data.output);
        } else {
          setOutput("Error: " + (data.error || 'Compilation failed'));
        }
      } else {
        if (data.results !== undefined) {
          setTestResults(data.results);
        } else {
          setOutput("Error: " + (data.error || 'Execution failed'));
        }
      }
    } catch (error) {
      setOutput("Error: " + error.message);
    } finally {
      setIsRunning(false);
    }
  };

  const handleManualAnalyze = async () => {
    setIsAnalyzing(true);
    setComplexity('Analyzing in background...');
    try {
      const response = await fetch(`${activeApiUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language }),
      });
      const data = await response.json();
      setComplexity(data.complexity || data.error || 'Analysis failed');
    } catch {
      setComplexity('Analysis failed');
    } finally {
      setIsAnalyzing(false);
      // Analysis counts toward the AI quota, so refresh the counter.
      onAiUsed?.();
    }
  };

  // Ctrl/Cmd+Enter runs the code. A ref always points at the latest
  // handleSubmit, so the shortcut never uses stale code or a stale API URL.
  const submitRef = useRef(handleSubmit);
  submitRef.current = handleSubmit;
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!isRunningRef.current) submitRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return {
    output,
    setOutput,
    isRunning,
    executionTime,
    setExecutionTime,
    testResults,
    setTestResults,
    complexity,
    setComplexity,
    isAnalyzing,
    handleSubmit,
    handleManualAnalyze
  };
};

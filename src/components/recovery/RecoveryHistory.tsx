
import React, { useEffect, useState } from "react";
import { recoveryService } from "../../services/recoveryService";
import type { RecoveryHistoryEntry } from "../../types/recovery";
import "../../styles/recovery.css";

interface RecoveryHistoryProps {
  recoveryId: string;
}

const RecoveryHistory: React.FC<RecoveryHistoryProps> = ({
  recoveryId
}) => {
  const [history, setHistory] = useState<RecoveryHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadHistory = async () => {
      try {
        setLoading(true);

        const data = await recoveryService.getHistory(recoveryId);

        setHistory(data);
        setError("");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to load history."
        );
      } finally {
        setLoading(false);
      }
    };

    loadHistory();
  }, [recoveryId]);

  if (loading) {
    return <p className="loading-message">Loading recovery history...</p>;
  }

  return (
    <div className="recovery-container">
      <div className="recovery-card">
        <h2>Recovery History</h2>

        <p>Track all activities related to your recovered item.</p>

        {error && <p className="error-message">{error}</p>}

        {history.length === 0 ? (
          <p>No recovery activities recorded yet.</p>
        ) : (
          <div className="history-timeline">
            {history.map((entry, index) => (
              <div className="history-item" key={entry.id || index}>
                <div className="timeline-dot" />

                <div className="history-content">
                  <h3>{entry.action.replaceAll("_", " ")}</h3>

                  <p>{entry.description}</p>

                  <small>
                    {new Date(entry.createdAt).toLocaleString()}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RecoveryHistory;

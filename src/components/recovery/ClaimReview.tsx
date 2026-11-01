
import React, { useEffect, useState } from "react";
import { recoveryService } from "../../services/recoveryService";
import type { Claim } from "../../types/recovery";
import "../../styles/recovery.css";

const ClaimReview: React.FC = () => {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadClaims = async () => {
    try {
      setLoading(true);
      const data = await recoveryService.getClaims();
      setClaims(data);
      setError("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load claims."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadClaims();
  }, []);

  const handleReview = async (
    claimId: string,
    decision: "VERIFIED" | "REJECTED"
  ) => {
    try {
      setMessage("");
      setError("");

      await recoveryService.reviewClaim(
        claimId,
        decision,
        notes[claimId] || ""
      );

      setMessage(
        decision === "VERIFIED"
          ? "Ownership claim verified successfully."
          : "Ownership claim rejected."
      );

      await loadClaims();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to review claim."
      );
    }
  };

  if (loading) {
    return <p className="loading-message">Loading ownership claims...</p>;
  }

  return (
    <div className="recovery-container">
      <div className="recovery-card">
        <h2>Ownership Claim Review</h2>

        <p>Review the information submitted by item owners.</p>

        {error && <p className="error-message">{error}</p>}
        {message && <p className="success-message">{message}</p>}

        {claims.length === 0 ? (
          <p>No ownership claims available.</p>
        ) : (
          claims.map(claim => (
            <div className="claim-card" key={claim.id}>
              <h3>Claim ID: {claim.id}</h3>

              <p>
                <strong>Item ID:</strong> {claim.itemId}
              </p>

              <p>
                <strong>Status:</strong> {claim.status}
              </p>

              <h4>Verification Answers</h4>

              {claim.answers.map((answer, index) => (
                <div key={index} className="answer-item">
                  <p>
                    <strong>{answer.question}</strong>
                  </p>
                  <p>{answer.answer}</p>
                </div>
              ))}

              {claim.status === "PENDING" && (
                <>
                  <label>Review Notes</label>

                  <textarea
                    rows={2}
                    value={notes[claim.id] || ""}
                    onChange={e =>
                      setNotes(previous => ({
                        ...previous,
                        [claim.id]: e.target.value
                      }))
                    }
                    placeholder="Enter review comments..."
                  />

                  <div className="button-group">
                    <button
                      onClick={() =>
                        handleReview(claim.id, "VERIFIED")
                      }
                    >
                      Accept Claim
                    </button>

                    <button
                      className="reject-button"
                      onClick={() =>
                        handleReview(claim.id, "REJECTED")
                      }
                    >
                      Reject Claim
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ClaimReview;

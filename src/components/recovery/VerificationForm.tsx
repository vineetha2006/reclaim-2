import React, { useState } from "react";
import { recoveryService } from "../../services/recoveryService";
import type { VerificationAnswer } from "../../types/recovery";
import "../../styles/recovery.css";
interface VerificationFormProps {
  itemId: string;
}

const VerificationForm: React.FC<VerificationFormProps> = ({
  itemId
}) => {
  const [answers, setAnswers] = useState([
    { question: "What is the brand or model of the item?", answer: "" },
    { question: "Describe any unique marks or scratches.", answer: "" },
    { question: "What special item is kept inside it?", answer: "" },
    { question: "Describe any additional identifying details.", answer: "" }
  ]);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const handleAnswerChange = (index: number, value: string) => {
    setAnswers(previous =>
      previous.map((item, i) =>
        i === index ? { ...item, answer: value } : item
      )
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setMessage("");
    setError("");

    if (answers.some(item => !item.answer.trim())) {
      setError("Please answer all verification questions.");
      return;
    }

    try {
      setLoading(true);

      await recoveryService.createClaim({
        itemId,
        answers: answers.map(item => ({
          question: item.question,
          answer: item.answer.trim()
        }))
      });

      setMessage("Ownership verification submitted successfully!");

      setAnswers(previous =>
        previous.map(item => ({ ...item, answer: "" }))
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to submit verification."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="recovery-container">
      <div className="recovery-card">
        <h2>Ownership Verification</h2>

        <p>
          Provide accurate details to prove that the reported
          item belongs to you.
        </p>

        <form onSubmit={handleSubmit}>
          {answers.map((item, index) => (
            <div className="form-group" key={index}>
              <label>{index + 1}. {item.question}</label>

              <textarea
                value={item.answer}
                onChange={e =>
                  handleAnswerChange(index, e.target.value)
                }
                placeholder="Enter your answer..."
                rows={3}
                required
              />
            </div>
          ))}

          {error && <p className="error-message">{error}</p>}
          {message && <p className="success-message">{message}</p>}

          <button type="submit" disabled={loading}>
            {loading ? "Submitting..." : "Submit Verification"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default VerificationForm;

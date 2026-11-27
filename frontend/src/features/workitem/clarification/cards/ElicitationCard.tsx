import { useTranslation } from 'react-i18next';
import { Fragment, type ReactNode } from 'react';
import { Tag } from 'antd';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import type { AcpElicitationAction } from '../types';
import { elicitationMessage, parseElicitationSchema, type ElicitationField } from './schemaForm';
import { unansweredFields } from './elicitationAnswer';
// 首席助理的问题历史也复用本卡片，不能依赖澄清面板先加载样式。
import '../clarification.css';

export interface ElicitationReply {
  action: 'accept' | 'decline';
  content?: Record<string, unknown>;
  /** 与结构化内容同时生成的文本答案，结构化提交因卡片过期被 409 拒绝时改用它发送。 */
  text?: string;
}

interface ElicitationCardProps {
  requestId: string;
  message?: string;
  schema: unknown;
  resolved?: boolean;
  expired?: boolean;
  action?: AcpElicitationAction;
  answers?: Record<string, unknown>;
  /** 卡片底部附加内容（原始答案、送达提示、继续回答），由问题历史传入。 */
  children?: ReactNode;
}

const RESOLVED_LABEL = {
  accept: 'clarification.answered',
  decline: 'clarification.skipped',
  cancel: 'clarification.canceled',
} as const satisfies Record<AcpElicitationAction, string>;

/**
 * 已回答问题的内联历史展示。进行中的问题由 ElicitationWizard 停靠卡片承担，
 * 这里把题干与最终回传值一并回显，保证执行详情里的历史问答可读。
 */
export function ElicitationCard({
  requestId, message, schema, resolved = false, action, answers, expired = false, children,
}: ElicitationCardProps) {
  const { t } = useTranslation('workitem');
  const form = parseElicitationSchema(schema);
  // 只答了一部分就提交是历史事故：已答卡片必须把漏答题目数标出来。
  const unanswered = resolved && action === 'accept'
    ? unansweredFields(form.fields, answers ?? {}, {}).length
    : 0;

  return (
    <div data-testid={`elicitation-card-${requestId}`} className="aw-cl-qa" style={{ marginBottom: 8 }}>
      <div className="aw-cl-qa-head" style={resolved || children ? undefined : { marginBottom: 0 }}>
        <span className="ic"><AwStrokeIcon name="help" size={13} /></span>
        <strong>{elicitationMessage(message, schema) || form.title || t('clarification.confirmation')}</strong>
        {unanswered > 0 ? (
          <Tag data-testid={`elicitation-card-unanswered-${requestId}`} color="orange">
            {t('clarification.unansweredTag', { count: unanswered })}
          </Tag>
        ) : null}
        {resolved ? (
          <Tag color={action === 'accept' ? 'green' : 'default'}>
            {expired ? t('clarification.history.expired') : (action && RESOLVED_LABEL[action] && t(RESOLVED_LABEL[action])) || t('clarification.resolved')}
          </Tag>
        ) : null}
      </div>

      {resolved ? <ResolvedAnswers fields={form.fields} answers={answers} /> : null}
      {children}
    </div>
  );
}

function ResolvedAnswers({
  fields, answers,
}: {
  fields: ElicitationField[];
  answers?: Record<string, unknown>;
}) {
  const { t } = useTranslation('workitem');
  const entries = Object.entries(answers ?? {});
  if (entries.length === 0) return null;

  return (
    <dl>
      {entries.map(([key, value]) => {
        const field = fields.find((f) => f.name === key);
        // 问题正文在 description（qodercli 把题目塞在首行），label 只是短话题。
        // 实时向导两者都渲染；已答卡片若只回显 label，执行详情里就只剩答案、
        // 读不出当初到底问了什么，所以这里把题干一并回显。
        const question = field?.description;
        return (
          <Fragment key={key}>
            <dt>
              {field?.label ?? key}
              {question ? <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{question}</span> : null}
            </dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>
              <span style={{ color: 'var(--aw-text-3)' }}>{t('clarification.answerPrefix')}</span>
              <span data-testid={`elicitation-answer-${key}`}>
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </span>
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

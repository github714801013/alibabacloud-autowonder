package com.aliyun.autowonder.conversation;

import com.aliyun.autowonder.access.RequireWorkspaceAccess;
import com.aliyun.autowonder.access.WorkspaceAccessLevel;
import com.aliyun.autowonder.common.result.Result;
import com.aliyun.autowonder.common.web.ConversationEventBoundedResponse;
import com.aliyun.autowonder.context.AutoWonderContext;
import com.aliyun.autowonder.conversation.dto.ConversationEventDisplayDtos;
import com.aliyun.autowonder.conversation.dto.ElicitationReplyRequest;
import com.aliyun.autowonder.conversation.dto.PlatformConversationPatchRequest;
import com.aliyun.autowonder.conversation.dto.PlatformConversationRequest;
import com.aliyun.autowonder.conversation.dto.PlatformConversationVO;
import com.aliyun.autowonder.conversation.dto.PlatformTurnRequest;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;

/**
 * 平台管家对话入口。
 *
 * <p>工作空间成员身份由 {@link RequireWorkspaceAccess} 逐请求校验，会话归属再由
 * {@link PlatformConversationAccessService} 校验：读取和写入都只放行给 Owner，
 * 写入只放行给 Owner 本人，工作空间管理员也不例外。
 */
@RestController
@RequestMapping("/api/platform/conversations")
@RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "查看平台管家对话", actionKey = "access.action.view_platform_assistant_conversations")
public class PlatformConversationController {

    @org.springframework.beans.factory.annotation.Autowired
    private PlatformPageContextService pageContextService;
    @org.springframework.beans.factory.annotation.Autowired
    private PlatformConversationImageService images;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ConversationEventDisplayReadService displayReadService;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ConversationEventBoundedResponse boundedResponse;
    private final PlatformConversationService service;
    private final ConversationTurnEventService turnEventService;
    private final ConversationCommandsService commandsService;

    public PlatformConversationController(PlatformConversationService service,
            ConversationTurnEventService turnEventService,
            ConversationCommandsService commandsService) {
        this.service = service;
        this.turnEventService = turnEventService;
        this.commandsService = commandsService;
    }

    @GetMapping
    public Result<List<PlatformConversationVO>> list(
            @RequestParam(required = false) Boolean archived,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Integer pageSize,
            @RequestParam(required = false) Integer page) {
        // 列表只能看到自己的会话，归属条件下沉到 SQL，不依赖调用方自觉。
        return Result.ok(service.list(currentWorkspaceId(), currentUserId(),
                archived, keyword, pageSize, page));
    }

    @PostMapping
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "新建平台管家对话", actionKey = "access.action.create_a_platform_assistant_conversation")
    public Result<PlatformConversationVO> create(@RequestBody PlatformConversationRequest request) {
        return Result.ok(service.create(currentWorkspaceId(), currentUserId(),
                request.getAgentId(), request.getTitle()));
    }

    @GetMapping("/{conversationId}")
    public void getBounded(@PathVariable Long conversationId,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        boundedResponse.write(request, response, get(conversationId));
    }

    public Result<PlatformConversationVO> get(@PathVariable Long conversationId) {
        return Result.ok(service.get(currentWorkspaceId(), conversationId, currentUserId()));
    }

    /**
     * 改名与归档必须在同一个事务里生效：拆成两次 service 调用时，前一个已提交、
     * 后一个抛异常，会话会停在半截状态，而客户端拿到的是失败响应。
     *
     * <p>顺带把响应形状统一成会话元信息 —— 原先只有「两个字段都不传」这一种情况
     * 会走 get() 返回带轮次和挂起卡片的完整正文，与只改名、只归档的返回并不一致。
     */
    @PatchMapping("/{conversationId}")
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "修改平台管家对话", actionKey = "access.action.update_a_platform_assistant_conversation")
    public Result<PlatformConversationVO> patch(@PathVariable Long conversationId,
            @RequestBody PlatformConversationPatchRequest request) {
        return Result.ok(service.patch(currentWorkspaceId(), conversationId, currentUserId(),
                request.getTitle(), request.getArchived()));
    }

    @DeleteMapping("/{conversationId}")
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "删除平台管家对话", actionKey = "access.action.delete_a_platform_assistant_conversation")
    public Result<Void> delete(@PathVariable Long conversationId) {
        service.delete(currentWorkspaceId(), conversationId, currentUserId());
        return Result.ok(null);
    }

    @GetMapping("/{conversationId}/turns/page")
    public void turnPage(@PathVariable Long conversationId,
            @RequestParam(required = false) Long beforeTurnId,
            @RequestParam(required = false) Long afterTurnId,
            @RequestParam(required = false) Integer limit,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        boundedResponse.write(request, response, Result.ok(service.turnPage(
                currentWorkspaceId(), conversationId, currentUserId(), beforeTurnId, afterTurnId, limit)));
    }

    @GetMapping("/{conversationId}/turns/{turnId}/questions/page")
    public void questionPage(@PathVariable Long conversationId, @PathVariable Long turnId,
            @RequestParam(required = false) Long beforeId, @RequestParam(required = false) Long afterId,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        boundedResponse.write(request, response, Result.ok(service.questionPage(
                currentWorkspaceId(), conversationId, currentUserId(), turnId, beforeId, afterId)));
    }
    @GetMapping("/{conversationId}/turns/{turnId}/questions/{id}/content")
    public void questionContent(@PathVariable Long conversationId, @PathVariable Long turnId, @PathVariable Long id,
            @RequestParam(required = false) String cursor,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        boundedResponse.write(request, response, Result.ok(service.questionContent(
                currentWorkspaceId(), conversationId, currentUserId(), turnId, id, cursor)));
    }
    @GetMapping("/{conversationId}/turns/{turnId}/content")
    public void turnContent(@PathVariable Long conversationId, @PathVariable Long turnId,
            @RequestParam(required = false) String cursor,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        boundedResponse.write(request, response, Result.ok(service.turnContent(
                currentWorkspaceId(), conversationId, currentUserId(), turnId, cursor)));
    }

    @GetMapping("/{conversationId}/events")
    public void events(
            @PathVariable Long conversationId,
            @RequestParam(defaultValue = "0") Long afterId,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        long tenantId = currentWorkspaceId();
        service.verifyReadable(tenantId, conversationId, currentUserId());
        boundedResponse.write(request, response, Result.ok(
                turnEventService.listEventsAfterBounded(tenantId, conversationId, afterId, 200)));
    }

    /** 按轮次取全事件，供历史轮次「查看执行详情」按需加载。 */
    @GetMapping("/{conversationId}/turns/{turnId}/events")
    public void turnEvents(
            @PathVariable Long conversationId,
            @PathVariable Long turnId,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        long tenantId = currentWorkspaceId();
        service.verifyReadable(tenantId, conversationId, currentUserId());
        boundedResponse.write(request, response, Result.ok(
                turnEventService.listEventsByTurnBounded(tenantId, conversationId, turnId)));
    }

    @GetMapping("/{conversationId}/turns/{turnId}/events/page")
    public void turnEventPage(
            @PathVariable Long conversationId, @PathVariable Long turnId,
            @RequestParam(defaultValue = "0") long afterId, @RequestParam(defaultValue = "500") int limit,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        long tenantId = currentWorkspaceId();
        service.verifyReadable(tenantId, conversationId, currentUserId());
        boundedResponse.write(request, response, Result.ok(
                turnEventService.listPlatformEventsByTurnPage(tenantId, conversationId, turnId, afterId, limit)));
    }

    /** 有界摘要列表：只读派生结果，不触原始大 payload。 */
    @GetMapping("/{conversationId}/turns/{turnId}/event-summaries")
    public void eventSummaries(@PathVariable Long conversationId, @PathVariable Long turnId,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) Integer limit,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        long tenantId = currentWorkspaceId();
        service.verifyReadable(tenantId, conversationId, currentUserId());
        ConversationEventDisplayDtos.SummaryPage page = displayReadService.readSummaries(
                tenantId, conversationId, turnId, cursor, limit);
        boundedResponse.write(request, response, Result.ok(page));
    }

    /** 分段全文：每次重新校验租户/会话/轮次/事件归属。 */
    @GetMapping("/{conversationId}/turns/{turnId}/event-summaries/{eventId}/content")
    public void eventContent(@PathVariable Long conversationId, @PathVariable Long turnId,
            @PathVariable Long eventId,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) String projectionVersion,
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        long tenantId = currentWorkspaceId();
        service.verifyReadable(tenantId, conversationId, currentUserId());
        ConversationEventDisplayDtos.ContentSegment segment = displayReadService.readContentSegment(
                tenantId, conversationId, turnId, eventId, cursor, projectionVersion);
        boundedResponse.write(request, response, Result.ok(segment));
    }

    @PostMapping("/{conversationId}/images")
    public Result<PlatformConversationImageService.Image> uploadImage(@PathVariable Long conversationId,
            @RequestParam("file") org.springframework.web.multipart.MultipartFile file) throws java.io.IOException {
        var conversation = service.get(currentWorkspaceId(),conversationId,currentUserId());
        if(conversation.getArchivedAt()!=null) throw new com.aliyun.autowonder.common.error.BizException(com.aliyun.autowonder.common.error.ErrorCode.PARAM_INVALID);
        return Result.ok(images.upload(currentWorkspaceId(),currentUserId(),conversationId,file));
    }

    @PostMapping("/{conversationId}/turns")
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "发送平台管家消息", actionKey = "access.action.send_a_platform_assistant_message")
    public Result<Void> submitTurn(@PathVariable Long conversationId,
            @RequestBody PlatformTurnRequest request) {
        service.verifyReadable(currentWorkspaceId(), conversationId, currentUserId());
        String context = pageContextService.snapshot(currentWorkspaceId(), currentUserId(), conversationId,
                request.getPagePath());
        if (request.getImageIds()!=null && !request.getImageIds().isEmpty())
            context = images.attach(context,currentWorkspaceId(),currentUserId(),conversationId,request.getImageIds());
        service.submitTurn(currentWorkspaceId(), conversationId, currentUserId(),
                request.getContent(), request.getClientMessageId(), context);
        return Result.ok(null);
    }

    @PostMapping("/{conversationId}/turns/{turnId}/cancel")
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "终止平台管家回复", actionKey = "access.action.stop_a_platform_assistant_reply")
    public Result<Void> cancelTurn(@PathVariable Long conversationId, @PathVariable Long turnId) {
        service.cancelTurn(currentWorkspaceId(), conversationId, currentUserId(), turnId);
        return Result.ok(null);
    }

    @PostMapping("/{conversationId}/turns/{turnId}/retry")
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "重试平台管家消息", actionKey = "access.action.retry_a_platform_assistant_message")
    public Result<Void> retryTurn(@PathVariable Long conversationId, @PathVariable Long turnId) {
        service.retryTurn(currentWorkspaceId(), conversationId, currentUserId(), turnId);
        return Result.ok(null);
    }

    /** 回答会驱动挂起的 Agent 继续本轮，属于写操作。 */
    @PostMapping("/{conversationId}/elicitations/{requestId}/reply")
    @RequireWorkspaceAccess(value = WorkspaceAccessLevel.READ_ONLY, action = "回答平台管家问题卡片", actionKey = "access.action.answer_a_platform_assistant_question_card")
    public Result<Void> replyElicitation(@PathVariable Long conversationId,
            @PathVariable String requestId,
            @RequestBody ElicitationReplyRequest request) {
        service.replyElicitation(currentWorkspaceId(), conversationId, currentUserId(),
                requestId, request.getAction(), request.getContent());
        return Result.ok(null);
    }

    /** 打开会话时触发命令探针；幂等去重在 service 内。只读能力、不改会话状态。 */
    @PostMapping("/{conversationId}/commands/refresh")
    public Result<Void> refreshCommands(@PathVariable Long conversationId) {
        long tenantId = currentWorkspaceId();
        service.verifyReadable(tenantId, conversationId, currentUserId());
        commandsService.refresh(tenantId, conversationId);
        return Result.ok(null);
    }

    private long currentWorkspaceId() {
        Long workspaceId = AutoWonderContext.get().getCurrentWorkspaceId();
        if (workspaceId == null) {
            throw new IllegalStateException("not authenticated");
        }
        return workspaceId;
    }

    private long currentUserId() {
        Long userId = AutoWonderContext.get().getUserId();
        if (userId == null) {
            throw new IllegalStateException("not authenticated");
        }
        return userId;
    }
}

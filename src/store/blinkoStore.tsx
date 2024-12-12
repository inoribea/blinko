import { _ } from '@/lib/lodash';
import { useEffect } from 'react';
import { PromisePageState, PromiseState } from './standard/PromiseState';
import { Store } from './standard/base';
import { helper } from '@/lib/helper';
import { ToastPlugin } from './module/Toast/Toast';
import { RootStore } from './root';
import { eventBus } from '@/lib/event';
import i18n from '@/lib/i18n';
import { api } from '@/lib/trpc';
import { type RouterOutput } from '@/server/routers/_app';
import { Attachment, NoteType, type Note } from '@/server/types';
import { ARCHIVE_BLINKO_TASK_NAME, DBBAK_TASK_NAME } from '@/lib/constant';
import { makeAutoObservable, observable, action } from 'mobx';
import { UserStore } from './user';

type filterType = {
  label: string;
  sortBy: string;
  direction: string;
}

export class BlinkoStore implements Store {
  sid = 'BlinkoStore';
  noteContent = '';
  isCreateMode: boolean = true
  curSelectedNote: Note | null = null;
  curMultiSelectIds: number[] = [];
  isMultiSelectMode: boolean = false;
  forceQuery: number = 0;
  allTagRouter = {
    title: 'total',
    href: '/all',
    icon: ''
  }
  noteListFilterConfig = {
    isArchived: false as boolean | null,
    isRecycle: false,
    isShare: null as boolean | null,
    type: 0,
    tagId: null as number | null,
    searchText: "",
    withoutTag: false,
    withFile: false,
    withLink: false,
    isUseAiQuery: false,
    startDate: null as Date | null,
    endDate: null as Date | null,
  }
  noteTypeDefault: NoteType = NoteType.BLINKO
  currentCommonFilter: filterType | null = null
  updateTicker = 0
  fullNoteList: Note[] = []
  upsertNote = new PromiseState({
    function: async ({ content = null, isArchived, isRecycle, type, id, attachments = [], refresh = true, isTop, isShare, showToast = true, references = [] }:
      { content?: string | null, isArchived?: boolean, isRecycle?: boolean, type?: NoteType, id?: number, attachments?: Attachment[], refresh?: boolean, isTop?: boolean, isShare?: boolean, showToast?: boolean, references?: number[] }) => {
      if (type == undefined) {
        type = this.noteTypeDefault
      }
      const res = await api.notes.upsert.mutate({ content, type, isArchived, isRecycle, id, attachments, isTop, isShare, references })
      if (this.config.value?.isUseAI) {
        if (res?.id) {
          api.ai.embeddingUpsert.mutate({ id: res!.id, content: res!.content, type: id ? 'update' : 'insert' }, { context: { skipBatch: true } })
        }
        for (const attachment of attachments) {
          api.ai.embeddingInsertAttachments.mutate({ id: res!.id, filePath: attachment.path }, { context: { skipBatch: true } })
        }
      }
      eventBus.emit('editor:clear')
      showToast && RootStore.Get(ToastPlugin).success(id ? i18n.t("update-successfully") : i18n.t("create-successfully"))
      refresh && this.updateTicker++
      return res
    }
  })

  noteList = new PromisePageState({
    function: async ({ page, size }) => {
      const notes = await api.notes.list.mutate({ ...this.noteListFilterConfig, page, size })
      return notes.map(i => { return { ...i, isExpand: false } })
    }
  })

  referenceSearchList = new PromisePageState({
    function: async ({ page, size, searchText }) => {
      return await api.notes.list.mutate({
        searchText
      })
    }
  })

  userList = new PromiseState({
    function: async () => {
      return await api.users.list.query()
    }
  })

  noteDetail = new PromiseState({
    function: async ({ id }) => {
      return await api.notes.detail.mutate({ id })
    }
  })

  dailyReviewNoteList = new PromiseState({
    function: async () => {
      return await api.notes.dailyReviewNoteList.query()
    }
  })

  resourceList = new PromisePageState({
    function: async ({ page, size, searchText }) => {
      return await api.attachments.list.query({ page, size, searchText })
    }
  })

  tagList = new PromiseState({
    function: async () => {
      const falttenTags = await api.tags.list.query(undefined, { context: { skipBatch: true } });
      const listTags = helper.buildHashTagTreeFromDb(falttenTags)
      let pathTags: string[] = [];
      listTags.forEach(node => {
        pathTags = pathTags.concat(helper.generateTagPaths(node));
      });
      return { falttenTags, listTags, pathTags }
    }
  })

  get showAi() {
    return this.config.value?.isUseAI
  }

  config = new PromiseState({
    function: async () => {
      return await api.config.list.query()
    }
  })

  task = new PromiseState({
    function: async () => {
      try {
        if (RootStore.Get(UserStore).role == 'superadmin') {
          return await api.task.list.query() ?? []
        }
        return []
      } catch (error) {
        return []
      }
    }
  })

  updateDBTask = new PromiseState({
    function: async (isStart) => {
      if (isStart) {
        await api.task.upsertTask.mutate({ time: '0 0 * * 0', type: 'start', task: DBBAK_TASK_NAME })
      } else {
        await api.task.upsertTask.mutate({ type: 'stop', task: DBBAK_TASK_NAME })
      }
      await this.task.call()
    }
  })
  updateArchiveTask = new PromiseState({
    function: async (isStart) => {
      if (isStart) {
        await api.task.upsertTask.mutate({ time: '0 0 * * 0', type: 'start', task: ARCHIVE_BLINKO_TASK_NAME })
      } else {
        await api.task.upsertTask.mutate({ type: 'stop', task: ARCHIVE_BLINKO_TASK_NAME })
      }
      await this.task.call()
    }
  })


  get DBTask() {
    return this.task.value?.find(i => i.name == DBBAK_TASK_NAME)
  }

  get ArchiveTask() {
    return this.task.value?.find(i => i.name == ARCHIVE_BLINKO_TASK_NAME)
  }


  async onBottom() {
    await this.noteList.callNextPage({})
  }

  onMultiSelectNote(id: number) {
    if (this.curMultiSelectIds.includes(id)) {
      this.curMultiSelectIds = this.curMultiSelectIds.filter(item => item !== id);
    } else {
      this.curMultiSelectIds.push(id);
    }
    if (this.curMultiSelectIds.length == 0) {
      this.isMultiSelectMode = false
    }
  }

  onMultiSelectRest() {
    this.isMultiSelectMode = false
    this.curMultiSelectIds = []
    this.updateTicker++
  }

  firstLoad() {
    this.tagList.call()
    this.config.call()
    this.dailyReviewNoteList.call()
    this.task.call()
  }

  async refreshData() {
    this.tagList.call()
    this.noteList.resetAndCall({})
    this.config.call()
    this.dailyReviewNoteList.call()
  }

  use() {
    useEffect(() => {
      this.firstLoad()
    }, [RootStore.Get(UserStore).id])

    useEffect(() => {
      if (this.updateTicker == 0) return
      this.refreshData()
    }, [this.updateTicker])
  }

  useQuery(router) {
    const { tagId, withoutTag, withFile, withLink, searchText } = router.query;
    useEffect(() => {
      if (!router.isReady) return
      this.noteListFilterConfig.type = NoteType.BLINKO
      this.noteTypeDefault = NoteType.BLINKO
      this.noteListFilterConfig.tagId = null
      this.noteListFilterConfig.isArchived = false
      this.noteListFilterConfig.withoutTag = false
      this.noteListFilterConfig.withLink = false
      this.noteListFilterConfig.withFile = false
      this.noteListFilterConfig.searchText = searchText ?? ''
      this.noteListFilterConfig.isRecycle = false
      this.noteListFilterConfig.startDate = null
      this.noteListFilterConfig.endDate = null
      this.noteListFilterConfig.isShare = null

      if (router.pathname == '/notes') {
        this.noteListFilterConfig.type = NoteType.NOTE
        this.noteTypeDefault = NoteType.NOTE
      }
      if (tagId) {
        this.noteListFilterConfig.tagId = Number(tagId) as number
      }
      if (withoutTag) {
        this.noteListFilterConfig.withoutTag = true
      }
      if (withLink) {
        this.noteListFilterConfig.withLink = true
      }
      if (withFile) {
        this.noteListFilterConfig.withFile = true
      }

      if (router.pathname == '/all') {
        this.noteListFilterConfig.type = -1
      }
      if (router.pathname == '/archived') {
        this.noteListFilterConfig.type = -1
        this.noteListFilterConfig.isArchived = true
      }
      if (router.pathname == '/trash') {
        this.noteListFilterConfig.type = -1
        this.noteListFilterConfig.isRecycle = true
      }
      this.noteList.resetAndCall({})
    }, [router.isReady, this.forceQuery])
  }

  @observable
  excludeEmbeddingTagId: number | null = null;

  @action
  setExcludeEmbeddingTagId(tagId: number | null) {
    this.excludeEmbeddingTagId = tagId;
    // 可能需要保存到本地存储或发送到服务器
  }

  constructor() {
    makeAutoObservable(this)
  }
}

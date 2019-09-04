import { Injectable } from '@angular/core';
import { AngularFirestore, QuerySnapshot } from '@angular/fire/firestore';
import { Subject, BehaviorSubject } from 'rxjs';
import { map, combineLatest } from 'rxjs/operators';
import { sortBy } from 'sort-by-typescript';

import { UserService, GroupService } from '../services';
import { IMessage } from '../models';

import { newLineString } from '../pipes/message-to-html.pipe';

const MESSAGE_LIMIT = 30;

const newLineRegex = new RegExp(newLineString, 'g');

@Injectable()
export class MessageService {
  public groupMessages$:  { [key: string]: BehaviorSubject<IMessage[]> } = {};
  public newMessageSubjects: { [key: string]: Subject<IMessage> };

  private currentUsersGroups: string[] = [];
  private groupMessages: { [key: string]: IMessage[] } = {};
  private currentUserId: string;

  constructor(
    private db: AngularFirestore,
    private userService: UserService,
    private groupService: GroupService,
  ) {
    this.subscribeToCurrentUser();
    this.subscribeToGroups();
    this.subscribeToNewMessages();
  }

public async sendMessage(groupId: string, text: string): Promise<void> {
    const timestamp = Date.now();

    this.db.collection('messages').add({
      timestamp,
      text: text.trim().replace(/[\n\r]/g, newLineString),
      groupId,
      sender: this.currentUserId,
    } as IMessage)
  }

  public async updateMessage(msgId: string, msgTxt: string): Promise<void> {
    // const timestamp = Date.now();

    this.db.collection('messages').doc(msgId).update({
      text: msgTxt,
    } as IMessage)
  }

  public async deleteMessage(msgId: string): Promise<void> {

    this.db.collection('messages').doc(msgId).delete().then(function() {
      console.log("Message successfully deleted!");
  }).catch(function(error) {
      console.error("Error removing message: ", error);
  });
  }

  public async loadPreviousMessagesForGroup(groupId: string, before: number = Date.now(), limit = MESSAGE_LIMIT): Promise<void> {
    const messages = await this.getPreviousMessagesForGroup(groupId, before, limit);

    this.addMessagesToGroup(groupId, messages);
  }

  private async getPreviousMessagesForGroup(groupId: string, before: number = Date.now(), limit = MESSAGE_LIMIT): Promise<IMessage[]> {
    const group = await this.groupService.getGroupById(groupId);

    if (group.individual) {
      const userGroup = await this.groupService.getUsersGroup(this.currentUserId);

      console.log(userGroup);

      const groupSnapshot = this.db.collection('messages', ref => ref
        .where('groupId', '==', groupId)
        .where('sender', '==', this.currentUserId)
        .orderBy('timestamp', 'desc')
        .startAfter(before)
        .limit(limit)
      ).get().toPromise();

      const userGroupSnapshot = this.db.collection('messages', ref => ref
        .where('groupId', '==', userGroup.id)
        .where('sender', '==', group.users[0])
        .orderBy('timestamp', 'desc')
        .startAfter(before)
        .limit(limit)
      ).get().toPromise();

      return (await Promise.all([
        this.mapSnapshotToMessages(await groupSnapshot),
        this.mapSnapshotToMessages(await userGroupSnapshot)
      ])).reduce((a, b) => a.concat(b));
    } else {
      const snapshot = await this.db.collection('messages', ref => ref
        .where('groupId', '==', groupId)
        .orderBy('timestamp', 'desc')
        .startAfter(before)
        .limit(limit)
      ).get().toPromise();

      return await this.mapSnapshotToMessages(snapshot);
    }
  }

  private async mapSnapshotToMessages(snapshot: QuerySnapshot<any>): Promise<IMessage[]> {
    return await Promise.all(snapshot.docs.map(async doc => {
      const message = doc.data();

      return {
        id: doc.id,
        ...message,
        text: message.text.replace(newLineRegex, newLineString),
      };
    })) as IMessage[];
  }

  private subscribeToCurrentUser(): void {
    this.userService.currentUserId$.subscribe(id => this.currentUserId = id);
  }

  private subscribeToGroups(): void {
    this.groupService.allGroups$.subscribe(groups => {
      this.currentUsersGroups = groups.map(group => group.id);

      groups.forEach(async group => {
        if (!this.groupMessages[group.id]) {
          this.groupMessages[group.id] = [];
          this.groupMessages$[group.id] = new BehaviorSubject([]);

          this.addMessagesToGroup(group.id, await this.getPreviousMessagesForGroup(group.id));
        }
      });
    });
  }

  private addMessagesToGroup(groupId: string, messages: IMessage[]) {
    const newMessages = Array.from(new Set([...this.groupMessages[groupId], ...messages])).sort(sortBy('timestamp'));

    if (newMessages.map(message => message.id).join('') !== this.groupMessages[groupId].map(message => message.id).join('')) {
      this.groupMessages[groupId] = newMessages;
      this.groupMessages$[groupId].next(newMessages);
    }
  }

  private subscribeToNewMessages(): void {
    this.db.collection('messages', ref => ref.where('timestamp', '>', Date.now())).stateChanges(['added']).pipe(
      map(actions =>
        actions.map(action => {
          const data = action.payload.doc.data() as IMessage;
          const id = action.payload.doc.id;

          return {
            id,
            ...data,
            text: data.text.replace(newLineRegex, '\\n'),
          };
        })
        .filter(message => this.currentUsersGroups.includes(message.groupId))
      )
    )
    .subscribe(messages => this.handleNewMessages(messages))
  }

  private handleNewMessages(messages: IMessage[]): void {
    const groupMessages: { [key: string]: IMessage[] } = {};

    messages.forEach(message => {
      if (!groupMessages[message.groupId]) {
        groupMessages[message.groupId] = [];
      }

      groupMessages[message.groupId].push(message);
    });

    Object.keys(groupMessages).forEach(groupId => {
      this.addMessagesToGroup(groupId, groupMessages[groupId]);
    });
  }
}

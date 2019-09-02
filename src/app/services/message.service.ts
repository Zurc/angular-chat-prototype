import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/firestore';
import { Subject, BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { sortBy } from 'sort-by-typescript';

import { UserService, GroupService } from '../services';
import { IMessage } from '../models';

import { newLineString } from '../pipes/message-to-html.pipe';
 
@Injectable()
export class MessageService {
  public groupMessages$:  { [key: string]: BehaviorSubject<IMessage[]> } = {};
  public newMessageSubjects: { [key: string]: Subject<IMessage> };
  
  private currentUsersGroups: string[] = [];
  private groupMessages: { [key: string]: IMessage[] } = {};
  private currentUser: string;

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
      sender: this.currentUser,
    } as IMessage)
  }

  public async getMessagesForGroup(groupId: string, before: Date = new Date(), limit = 30): Promise<IMessage[]> {
    const snapshot = await this.db.collection('messages', ref => ref
      .where('groupId', '==', groupId)
      .orderBy('timestamp', 'desc')
      .startAt(before)
      .limit(limit)     
    ).get().toPromise();

    return await Promise.all(snapshot.docs.map(async doc => {
      const message = await doc.data();
      
      return {
        id: doc.id,
        ...message,
      };
    })) as IMessage[];
  }

  private subscribeToCurrentUser(): void {
    this.userService.currentUser$.subscribe(id => this.currentUser = id);
  }

  private subscribeToGroups(): void {
    this.groupService.allGroups$.subscribe(groups => {
      this.currentUsersGroups = groups.map(group => group.id);

      groups.forEach(async group => {
        if (!this.groupMessages[group.id]) {
          this.groupMessages[group.id] = [];
          this.groupMessages$[group.id] = new BehaviorSubject([]);
          
          this.addMessagesToGroup(group.id, await this.getMessagesForGroup(group.id));
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
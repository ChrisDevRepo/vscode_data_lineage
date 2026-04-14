import { getSession } from '../src/ai/session';

function testSession() {
    console.log('--- Testing AiSession instantiation ---');
    try {
        const sess = getSession();
        console.log('Session ID:', sess.id);
        console.log('ColumnStore exists:', !!sess.columnStore);
        sess.columnStore.clear();
        console.log('ColumnStore.clear() called successfully');
    } catch (err) {
        console.error('FAILED to create session:', err);
        process.exit(1);
    }
}

testSession();

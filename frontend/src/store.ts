import { configureStore, createSlice } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { useDispatch, useSelector } from 'react-redux';
import { api } from './api';

const ui = createSlice({
  name: 'ui',
  initialState: { dark: true },
  reducers: { toggleTheme: state => { state.dark = !state.dark; } },
});

export const store = configureStore({
  reducer: { ui: ui.reducer, [api.reducerPath]: api.reducer },
  middleware: getDefaultMiddleware => getDefaultMiddleware().concat(api.middleware),
  // Login is an RTK Query mutation; never send its arguments to Redux DevTools.
  devTools: false,
});
setupListeners(store.dispatch);

export const { toggleTheme } = ui.actions;
export const useAppDispatch = useDispatch.withTypes<typeof store.dispatch>();
export const useAppSelector = useSelector.withTypes<ReturnType<typeof store.getState>>();
